import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { setMcpTestServer } from "./support/mcpServerMock";
import {
    McpAttachmentTranscription,
    McpTranscriptionRunner,
    runMcpTranscriptionCommand
} from "../src/server/api/interfaces/mcpAttachmentTranscription";

function wave(pcm: Buffer): Buffer {
    const value = Buffer.alloc(44 + pcm.length);
    value.write("RIFF", 0, "ascii");
    value.writeUInt32LE(36 + pcm.length, 4);
    value.write("WAVE", 8, "ascii");
    value.write("fmt ", 12, "ascii");
    value.writeUInt32LE(16, 16);
    value.writeUInt16LE(1, 20);
    value.writeUInt16LE(1, 22);
    value.writeUInt32LE(16000, 24);
    value.writeUInt32LE(32000, 28);
    value.writeUInt16LE(2, 32);
    value.writeUInt16LE(16, 34);
    value.write("data", 36, "ascii");
    value.writeUInt32LE(pcm.length, 40);
    pcm.copy(value, 44);
    return value;
}

describe("MCP bounded local attachment transcription", () => {
    let directory: string;
    let source: string;
    let model: string;
    let reportedBytes: bigint;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "bluebubbles-transcription-test-"));
        source = join(directory, "voice.caf");
        model = join(directory, "model.bin");
        writeFileSync(source, Buffer.from([1, 2, 3]));
        writeFileSync(model, Buffer.from([1]));
        reportedBytes = BigInt(3);
        const statement: any = {
            safeIntegers: () => statement,
            get: () => ({
                filename: source,
                total_bytes: reportedBytes,
                mime_type: "audio/x-caf",
                uti: "com.apple.coreaudio-format"
            })
        };
        setMcpTestServer({
            iMessageRepo: { db: { driver: { databaseConnection: { prepare: () => statement } } } }
        });
    });

    afterEach(() => rmSync(directory, { recursive: true, force: true }));

    it("decodes and transcribes locally through bounded commands without persisting artifacts", async () => {
        const calls: Array<{ command: string; args: string[]; timeout: number }> = [];
        const runner: McpTranscriptionRunner = async (command, args, options) => {
            calls.push({ command, args, timeout: options.timeout });
            if (command === "synthetic-ffmpeg") {
                const privateInput = args[args.indexOf("-i") + 1];
                expect(privateInput).not.toBe(source);
                expect(readFileSync(privateInput)).toEqual(Buffer.from([1, 2, 3]));
                writeFileSync(args[args.length - 1], wave(Buffer.from([1, 0])));
            }
            if (command === "synthetic-whisper") {
                const prefix = args[args.indexOf("-of") + 1];
                writeFileSync(`${prefix}.txt`, "hello from the fixture\n");
            }
            return { status: 0 };
        };

        const result = await McpAttachmentTranscription.read({ attachmentId: 1 }, runner, {
            MESSAGES_ATTACHMENT_ROOT: directory,
            MESSAGES_WHISPER_MODEL: model,
            MESSAGES_FFMPEG: "synthetic-ffmpeg",
            MESSAGES_WHISPER_CLI: "synthetic-whisper"
        });

        expect(result.text).toContain("Machine transcript (local Whisper, English");
        expect(result.text).toContain("hello from the fixture");
        expect(calls.map(call => call.command)).toEqual(["synthetic-ffmpeg", "synthetic-whisper"]);
        expect(calls.map(call => call.timeout)).toEqual([10_000, 25_000]);
    });

    it("kills a stalled local command at its bounded deadline", async () => {
        const started = Date.now();
        const result = await runMcpTranscriptionCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
            timeout: 25,
            stdio: "ignore"
        });

        expect(result.status).toBeNull();
        expect(result.error?.message).toContain("timed out");
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("returns a nonfatal explicit result when the model is unavailable", async () => {
        expect(
            (
                await McpAttachmentTranscription.read({ attachmentId: 1 }, async () => ({ status: 0 }), {
                    MESSAGES_ATTACHMENT_ROOT: directory,
                    MESSAGES_WHISPER_MODEL: join(directory, "missing.bin")
                })
            ).text
        ).toContain("model is not installed");
    });

    it("rejects a symlink source even when its target is under the attachment root", async () => {
        const target = source;
        source = join(directory, "voice-link.caf");
        symlinkSync(target, source);

        const result = await McpAttachmentTranscription.read({ attachmentId: 1 }, async () => ({ status: 0 }), {
            MESSAGES_ATTACHMENT_ROOT: directory,
            MESSAGES_WHISPER_MODEL: model
        });

        expect(result.text).toContain("local audio source is missing or unsafe");
    });

    it("rejects a regular source outside the configured Messages attachment root", async () => {
        const outside = mkdtempSync(join(tmpdir(), "bluebubbles-transcription-outside-test-"));
        try {
            source = join(outside, "voice.caf");
            writeFileSync(source, Buffer.from([1, 2, 3]));
            const result = await McpAttachmentTranscription.read({ attachmentId: 1 }, async () => ({ status: 0 }), {
                MESSAGES_ATTACHMENT_ROOT: directory,
                MESSAGES_WHISPER_MODEL: model
            });
            expect(result.text).toContain("local audio source is missing or unsafe");
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it("rejects an over-limit reported source size before starting a worker", async () => {
        reportedBytes = BigInt(8_000_001);
        const runner = jest.fn(async () => ({ status: 0 }));

        const result = await McpAttachmentTranscription.read({ attachmentId: 1 }, runner, {
            MESSAGES_ATTACHMENT_ROOT: directory,
            MESSAGES_WHISPER_MODEL: model
        });

        expect(result.text).toContain("safe source limit");
        expect(runner).not.toHaveBeenCalled();
    });

    it.each([{}, { attachmentId: 0 }, { attachmentId: 1, unexpected: true }])(
        "rejects malformed request %#",
        async request => {
            await expect(McpAttachmentTranscription.read(request)).rejects.toThrow();
        }
    );
});
