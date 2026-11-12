import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import { setMcpTestServer } from "./support/mcpServerMock";
import { McpChatCatalog, MCP_CHAT_PAGE_MAX_BYTES } from "../src/server/api/interfaces/mcpChatCatalog";
import {
    McpEventEvidence,
    MCP_EVENT_MAX_SQL_QUERIES,
    MCP_EVENT_RESPONSE_MAX_BYTES
} from "../src/server/api/interfaces/mcpEventEvidence";
import { McpMessageHistory, MCP_HISTORY_RESPONSE_MAX_BYTES } from "../src/server/api/interfaces/mcpMessageHistory";
import { McpContactActivity } from "../src/server/api/interfaces/mcpContactActivity";
import { McpAttachmentTranscription } from "../src/server/api/interfaces/mcpAttachmentTranscription";
import { McpAttachmentMetadata } from "../src/server/api/interfaces/mcpAttachmentMetadata";
import {
    MCP_CHAT_SUCCESS_MESSAGE,
    MCP_EVENT_SUCCESS_MESSAGE,
    MCP_HISTORY_SUCCESS_MESSAGE,
    mcpSuccessResponseBytes
} from "../src/server/api/interfaces/mcpResponseLimits";

function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function parameterLiteral(value: unknown): string {
    if (typeof value === "bigint" || typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "1" : "0";
    if (value == null) return "NULL";
    return JSON.stringify(String(value));
}

class CliStatement {
    constructor(private readonly database: CliDatabase, private readonly sql: string) {}

    safeIntegers(): CliStatement {
        return this;
    }

    all(...parameters: unknown[]): Record<string, unknown>[] {
        return this.database.query(this.sql, parameters);
    }

    get(...parameters: unknown[]): Record<string, unknown> | undefined {
        return this.all(...parameters)[0];
    }
}

class CliDatabase {
    queryCount = 0;

    constructor(readonly path: string) {}

    prepare(sql: string): CliStatement {
        this.queryCount += 1;
        return new CliStatement(this, sql);
    }

    query(sql: string, parameters: unknown[]): Record<string, unknown>[] {
        const bindings = parameters.map((value, index) => `.parameter set ?${index + 1} ${parameterLiteral(value)}`);
        const input = [".parameter init", ...bindings, `${sql};`].join("\n");
        const result = spawnSync("sqlite3", ["-json", this.path], {
            input,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024
        });
        if (result.status !== 0) throw new Error(`Synthetic SQLite query failed: ${result.stderr.trim()}`);
        if (result.stdout.trim().length === 0) return [];
        const rows = JSON.parse(quoteJsonIntegers(result.stdout)) as Record<string, unknown>[];
        const integerColumns = new Set([
            "row_id",
            "sort_rank",
            "style",
            "date_apple",
            "message_id",
            "id",
            "handle_row",
            "maximum_row",
            "handle_id",
            "is_from_me",
            "associated_message_type",
            "cache_has_attachments",
            "item_type",
            "is_system_message",
            "message_row",
            "chat_row",
            "has_attachments",
            "attachment_row",
            "total_bytes"
        ]);
        return rows.map(row =>
            Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                    key,
                    integerColumns.has(key) && typeof value === "string" && /^-?[0-9]+$/.test(value)
                        ? BigInt(value)
                        : value
                ])
            )
        );
    }
}

function quoteJsonIntegers(value: string): string {
    let result = "";
    let inString = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (inString) {
            result += character;
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === '"') inString = false;
            continue;
        }
        if (character === '"') {
            inString = true;
            result += character;
            continue;
        }
        if ((character === "-" || /[0-9]/.test(character)) && /[:,[]/.test(value[index - 1] ?? "")) {
            const match = value.slice(index).match(/^-?[0-9]+/);
            if (match != null && !/[.eE]/.test(value[index + match[0].length] ?? "")) {
                result += `"${match[0]}"`;
                index += match[0].length - 1;
                continue;
            }
        }
        result += character;
    }
    return result;
}

function execute(path: string, sql: string): void {
    const result = spawnSync("sqlite3", [path], { input: sql, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Synthetic SQLite fixture failed: ${result.stderr.trim()}`);
}

describe("MCP database-backed behavior", () => {
    let databasePath: string;
    let database: CliDatabase;
    let decodedIds: number[][];

    beforeEach(() => {
        const directory = mkdtempSync(join(tmpdir(), "bluebubbles-mcp-synthetic-"));
        databasePath = join(directory, "messages.sqlite3");
        writeFileSync(databasePath, "");
        execute(
            databasePath,
            `CREATE TABLE chat(guid TEXT,chat_identifier TEXT,display_name TEXT,room_name TEXT,style INTEGER);
             CREATE TABLE handle(id TEXT);
             CREATE TABLE message(
                guid TEXT,date INTEGER,handle_id INTEGER,is_from_me INTEGER,
                associated_message_type INTEGER,associated_message_guid TEXT,
                associated_message_emoji TEXT,cache_has_attachments INTEGER,
                item_type INTEGER,is_system_message INTEGER,text TEXT,service TEXT
             );
             CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);
             CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER);
             CREATE TABLE attachment(
                guid TEXT,filename TEXT,transfer_name TEXT,mime_type TEXT,uti TEXT,total_bytes INTEGER
             );
             CREATE TABLE message_attachment_join(message_id INTEGER,attachment_id INTEGER);`
        );
        database = new CliDatabase(databasePath);
        decodedIds = [];
        const repository = {
            dbPath: databasePath,
            db: { driver: { databaseConnection: database } },
            getMessages: async (options: any) => {
                const ids = (options.where[0].args.mcpHistoryIds ?? options.where[0].args.mcpActivityIds) as number[];
                decodedIds.push(ids);
                if (ids.length === 0) return [[], 0];
                const marks = ids.map(() => "?").join(",");
                const rows = database.query(
                    `SELECT ROWID AS row_id,guid,is_from_me,text,service FROM message WHERE ROWID IN (${marks})`,
                    ids
                );
                const messages = rows.map(row => ({
                    ROWID: Number(row.row_id),
                    guid: row.guid,
                    isFromMe: Boolean(row.is_from_me),
                    text: row.text,
                    service: row.service,
                    universalText: () => row.text
                }));
                return [messages, messages.length];
            }
        };
        setMcpTestServer({ iMessageRepo: repository });
    });

    function exclusionFixture() {
        execute(
            databasePath,
            `
            INSERT INTO handle(ROWID,id) VALUES(7,'person@example.invalid'),(8,'other@example.invalid');
            INSERT INTO chat(ROWID,guid,chat_identifier,style) VALUES
                (11,'any;-;person@example.invalid','person@example.invalid',45),
                (12,'iMessage;+;shared-group','shared-group',43),(13,'iMessage;+;other-group','other-group',43);
            INSERT INTO chat_handle_join(chat_id,handle_id) VALUES(11,7),(12,7),(12,8),(13,8);
            INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,text,associated_message_type) VALUES
                (100,'excluded-incoming',800000000000000010,7,0,'private synthetic',0),
                (101,'group-incoming',800000000000000009,7,0,'allowed synthetic',0),
                (102,'excluded-outgoing',800000000000000009,0,1,'private synthetic',0),
                (103,'group-reaction',800000000000000009,7,0,'allowed synthetic',2001),
                (104,'excluded-reaction',800000000000000008,7,0,'private synthetic',2001),
                (105,'group-outgoing',800000000000000007,0,1,'allowed synthetic',0),
                (106,'other-group',800000000000000006,8,0,'allowed synthetic',0),
                (107,'shared-message-row',800000000000000011,7,0,'private synthetic',0);
            INSERT INTO chat_message_join(chat_id,message_id) VALUES
                (11,100),(12,101),(11,102),(12,103),(11,104),(12,105),(13,106),(11,107),(12,107);
            INSERT INTO attachment(ROWID,guid,filename,transfer_name,mime_type,total_bytes) VALUES
                (21,'excluded-file','/nonexistent/private-synthetic.caf','private.caf','audio/x-caf',3),
                (22,'group-file','/nonexistent/allowed-synthetic.caf','allowed.caf','audio/x-caf',3),
                (23,'shared-file','/nonexistent/shared-synthetic.caf','shared.caf','audio/x-caf',3);
            INSERT INTO message_attachment_join(message_id,attachment_id) VALUES(100,21),(101,22),(100,23),(101,23);
        `
        );
    }

    it.each([
        { excludeChatGuids: ["any;-;person@example.invalid"] },
        { excludeChatRowIds: [11] },
        { excludeChatGuids: ["missing-guid"], excludeChatRowIds: [11] }
    ])("excludes native chat identity before decoding with gap-free tied-date pages %#", async exclusions => {
        exclusionFixture();
        const seen: number[] = [];
        let edge: Record<string, unknown> = {};
        for (;;) {
            const page = await McpMessageHistory.read({
                limit: 2,
                anchorApple: "800000000000000020",
                ...exclusions,
                ...edge
            });
            seen.push(...page.rows.map(row => row.originalROWID));
            if (page.rows.length === 0) break;
            const last = page.rows[page.rows.length - 1];
            edge = { lastDateApple: last.dateApple, lastRow: last.originalROWID };
        }
        expect(seen).toEqual([103, 101, 105, 106]);
        expect(decodedIds.flat()).toEqual(seen);
        const empty = await McpMessageHistory.read({
            limit: 101,
            anchorApple: "800000000000000020",
            chatGuid: "any;-;person@example.invalid",
            ...exclusions
        });
        expect(empty.rows).toEqual([]);
        expect(decodedIds.flat()).toEqual(seen);
        const group = await McpMessageHistory.read({
            limit: 101,
            anchorApple: "800000000000000020",
            chatGuid: "iMessage;+;shared-group",
            searchTerm: "allowed",
            threshold: 0,
            ...exclusions
        });
        expect(group.rows.map(row => row.originalROWID)).toEqual([103, 101, 105]);
        expect(group.rows.every(row => row.matches)).toBe(true);
        const contact = await McpMessageHistory.read({
            limit: 101,
            anchorApple: "800000000000000020",
            contactAddress: "person@example.invalid",
            ...exclusions
        });
        expect(contact.rows.map(row => row.originalROWID)).toEqual([103, 101]);
        expect(decodedIds.flat().some(id => [100, 102, 104, 107].includes(id))).toBe(false);
    });

    it("excludes attachment metadata, exact lookup, transcription and cross-chat activity at the source", async () => {
        exclusionFixture();
        const exclusions = { excludeChatRowIds: [11] };
        expect(McpAttachmentMetadata.read(exclusions).rows.map(row => row.attachmentId)).toEqual([22]);
        expect(McpAttachmentMetadata.read({ attachmentId: 21, ...exclusions }).rows).toEqual([]);
        expect(McpAttachmentMetadata.read({ attachmentId: 23, ...exclusions }).rows).toEqual([]);
        const runner = jest.fn();
        const transcript = await McpAttachmentTranscription.read({ attachmentId: 21, ...exclusions }, runner);
        expect(transcript.text).toContain("was not found");
        expect(runner).not.toHaveBeenCalled();
        const activity = await McpContactActivity.read({
            addresses: ["person@example.invalid"],
            limit: 20,
            ...exclusions
        });
        expect(activity.rows.map(row => row.messageId)).toEqual([103, 101, 105]);
        expect(activity.coverage.matchedChatCount).toBe(1);
        expect(activity.rows.flatMap(row => (row.attachments as any).items).map(row => row.id)).toEqual([22]);
        expect(activity.rows.every(row => row.chat.id === 12)).toBe(true);
        expect(decodedIds.flat().some(id => [100, 102, 104, 107].includes(id))).toBe(false);
    });

    it("paginates every chat in SQLite NOCASE order without losing participant-less groups", () => {
        const inserts = [
            `INSERT INTO chat(ROWID,guid,chat_identifier,display_name,room_name,style) VALUES(1,'g1','i1','alpha','r1',43);`,
            `INSERT INTO chat(ROWID,guid,chat_identifier,display_name,room_name,style) VALUES(2,'g2','i2','Alpha','r2',43);`,
            `INSERT INTO chat(ROWID,guid,chat_identifier,display_name,room_name,style) VALUES(3,'g3','i3','Álpha','r3',43);`,
            `INSERT INTO chat(ROWID,guid,chat_identifier,display_name,room_name,style) VALUES(4,'g4','i4','Beta','r4',43);`,
            `INSERT INTO chat(ROWID,guid,chat_identifier,display_name,room_name,style) VALUES(5,'g5','i5','',NULL,43);`,
            `INSERT INTO chat(ROWID,guid,chat_identifier,display_name,room_name,style) VALUES(6,'g6','i6',NULL,NULL,43);`
        ];
        for (let row = 7; row <= 146; row += 1) {
            const name = `zz-${String(row).padStart(3, "0")}-${"x".repeat(1800)}`;
            inserts.push(
                `INSERT INTO chat(ROWID,guid,chat_identifier,display_name,room_name,style) VALUES(${row},'g${row}','i${row}',${sqlLiteral(
                    name
                )},NULL,43);`
            );
        }
        execute(databasePath, inserts.join("\n"));

        const seen: any[] = [];
        const pageSizes: number[] = [];
        let cursor: string | null = null;
        do {
            const page = McpChatCatalog.read({ groupsOnly: true, limit: 100, cursor });
            pageSizes.push(mcpSuccessResponseBytes(MCP_CHAT_SUCCESS_MESSAGE, page));
            seen.push(...page.rows);
            cursor = page.nextCursor;
        } while (cursor != null);

        expect(pageSizes.every(size => size <= MCP_CHAT_PAGE_MAX_BYTES)).toBe(true);
        expect(new Set(seen.map(row => row.guid)).size).toBe(146);
        expect(seen.slice(0, 2).map(row => row.originalROWID)).toEqual([2, 1]);
        expect(seen.findIndex(row => row.guid === "g3")).toBeGreaterThan(seen.findIndex(row => row.guid === "g4"));
        expect(seen.slice(-2).map(row => row.originalROWID)).toEqual([6, 5]);
    });

    it("fails explicitly when one chat cannot fit rather than advancing its cursor", () => {
        execute(
            databasePath,
            `INSERT INTO chat(ROWID,guid,chat_identifier,display_name,room_name,style)
             VALUES(1,'oversized','oversized',${sqlLiteral("x".repeat(MCP_CHAT_PAGE_MAX_BYTES + 1))},NULL,43);`
        );
        expect(() => McpChatCatalog.read({ groupsOnly: true, limit: 1 })).toThrow(
            "One MCP chat row exceeds the response byte limit"
        );
    });

    it("round-trips a long multibyte sort name through an emitted cursor", () => {
        const longName = `a-${"界".repeat(3000)}`;
        execute(
            databasePath,
            `INSERT INTO chat(ROWID,guid,chat_identifier,display_name,room_name,style)
             VALUES(1,'long-name','long-name',${sqlLiteral(longName)},NULL,43),
                   (2,'later','later','z-later',NULL,43);`
        );
        const first = McpChatCatalog.read({ groupsOnly: true, limit: 1 });
        expect(first.rows.map(row => row.guid)).toEqual(["long-name"]);
        expect(first.nextCursor).not.toBeNull();
        const second = McpChatCatalog.read({ groupsOnly: true, limit: 1, cursor: first.nextCursor });
        expect(second.rows.map(row => row.guid)).toEqual(["later"]);
        expect(second.nextCursor).toBeNull();
    });

    it("fails before returning a cursor with an over-limit sort name", () => {
        execute(
            databasePath,
            `INSERT INTO chat(ROWID,guid,chat_identifier,display_name,room_name,style)
             VALUES(1,'long-name','long-name',${sqlLiteral(`a-${"x".repeat(8192)}`)},NULL,43),
                   (2,'later','later','z-later',NULL,43);`
        );
        expect(() => McpChatCatalog.read({ groupsOnly: true, limit: 1 })).toThrow("cursor character limit");
    });

    it("uses tied native timestamps and ROWIDs for gap-free history pages including an empty edge page", async () => {
        execute(
            databasePath,
            `INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
             VALUES(1,'m1',100,0,0,0,'one','iMessage'),
                   (2,'m2',200,0,1,0,'two','iMessage'),
                   (3,'m3',200,0,0,0,'three','iMessage'),
                   (4,'m4',300,0,1,0,'four','iMessage');`
        );

        const first = await McpMessageHistory.read({ limit: 2, anchorApple: "500000000000" });
        expect(mcpSuccessResponseBytes(MCP_HISTORY_SUCCESS_MESSAGE, first)).toBeLessThanOrEqual(
            MCP_HISTORY_RESPONSE_MAX_BYTES
        );
        expect(first.rows.map(row => row.originalROWID)).toEqual([4, 3]);
        expect(first.rows.map(row => row.dateApple)).toEqual(["300000000000", "200000000000"]);
        const second = await McpMessageHistory.read({
            limit: 2,
            anchorApple: "500000000000",
            lastDateApple: "200000000000",
            lastRow: 3
        });
        expect(second.rows.map(row => row.originalROWID)).toEqual([2, 1]);
        const empty = await McpMessageHistory.read({
            limit: 2,
            anchorApple: "500000000000",
            lastDateApple: "100000000000",
            lastRow: 1
        });
        expect(empty.rows).toEqual([]);
    });

    it("scores fuzzy history rows in BlueBubbles while preserving scanned-page ordering", async () => {
        execute(
            databasePath,
            `INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
             VALUES(1,'m1',100,0,0,0,'meeting tomorrow at noon','iMessage'),
                   (2,'m2',200,0,0,0,'unrelated body','iMessage');`
        );
        const page = await McpMessageHistory.read({
            limit: 2,
            anchorApple: "500000000000",
            searchTerm: "meeting tomorow",
            threshold: 0.6
        });
        expect(page.rows.map(row => row.originalROWID)).toEqual([2, 1]);
        expect(page.rows[0].matches).toBe(false);
        expect(page.rows[1].matches).toBe(true);
        expect(page.rows[1].score).toBeGreaterThanOrEqual(0.6);
    });

    it("fails the whole fuzzy page before returning rows when its shared CPU budget is exhausted", async () => {
        execute(
            databasePath,
            `INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
             VALUES(1,'m1',100,0,0,0,${sqlLiteral("b".repeat(2000))},'iMessage');`
        );
        await expect(
            McpMessageHistory.read({
                limit: 1,
                anchorApple: "500000000000",
                searchTerm: "a".repeat(2000),
                threshold: 0.6
            })
        ).rejects.toThrow("bounded computation budget");
    });

    it("computes exact-alias activity across every shared chat before limiting", async () => {
        execute(
            databasePath,
            `INSERT INTO handle(ROWID,id) VALUES(1,'+1 (415) 555-0123'),(2,'other@example.com');
             INSERT INTO chat(ROWID,guid,style) VALUES(10,'iMessage;+;direct',45),(11,'iMessage;+;group',43);
             INSERT INTO chat_handle_join(chat_id,handle_id) VALUES(10,1),(11,1),(11,2);
             INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
             VALUES(20,'old',100,1,0,0,'old','iMessage'),(21,'new',200,2,1,0,'new','iMessage');
             INSERT INTO chat_message_join(chat_id,message_id) VALUES(10,20),(11,21);
             INSERT INTO attachment(ROWID,guid,filename,transfer_name,mime_type,uti,total_bytes)
             VALUES(30,'a30','~/Library/Messages/Attachments/photo.jpg','photo.jpg','image/jpeg','public.jpeg',1234);
             INSERT INTO message_attachment_join(message_id,attachment_id) VALUES(21,30);`
        );
        const response = await McpContactActivity.read({ addresses: ["+14155550123"], limit: 1 });
        expect(response.rows).toEqual([
            expect.objectContaining({
                messageId: 21,
                messageGuid: "new",
                text: "new",
                textStatus: "plain_text",
                hasAttachments: true,
                chat: expect.objectContaining({ id: 11, type: "group", participantCount: 2 }),
                attachments: expect.objectContaining({
                    status: "ok",
                    items: [expect.objectContaining({ id: 30, name: "photo.jpg" })]
                })
            })
        ]);
        expect(response.coverage).toMatchObject({
            matchedHandleCount: 1,
            matchedChatCount: 2,
            unmatchedAddresses: [],
            truncated: true
        });
    });

    it("searches attachment metadata in the backend and resolves an exact ROWID", () => {
        execute(
            databasePath,
            `INSERT INTO handle(ROWID,id) VALUES(1,'person@example.com');
             INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
             VALUES(20,'m20',200,1,0,0,'with attachment','iMessage');
             INSERT INTO attachment(ROWID,guid,filename,transfer_name,mime_type,uti,total_bytes)
             VALUES(30,'a30','~/Library/Messages/Attachments/photo.jpg','photo.jpg','image/jpeg','public.jpeg',1234),
                   (31,'a31','~/Library/Messages/Attachments/note.pdf','note.pdf','application/pdf','com.adobe.pdf',4321);
             INSERT INTO message_attachment_join(message_id,attachment_id) VALUES(20,30),(20,31);`
        );
        const searched = McpAttachmentMetadata.read({
            contactAddress: "person@example.com",
            mimeType: "image/",
            startApple: "100000000000",
            endApple: "300000000000",
            limit: 10
        });
        expect(searched.rows).toEqual([
            expect.objectContaining({
                attachmentId: 30,
                attachmentGuid: "a30",
                filePath: "~/Library/Messages/Attachments/photo.jpg",
                filename: "photo.jpg",
                mimeType: "image/jpeg",
                downloadMimeType: "image/jpeg",
                messageId: 20
            })
        ]);
        const exact = McpAttachmentMetadata.read({ attachmentId: 31 });
        expect(exact.rows).toEqual([expect.objectContaining({ attachmentId: 31, filename: "note.pdf" })]);
    });

    it("advertises the existing non-original download conversion MIME for HEIC and CAF", () => {
        execute(
            databasePath,
            `INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
             VALUES(20,'m20',200,0,0,0,'media','iMessage');
             INSERT INTO attachment(ROWID,guid,filename,transfer_name,mime_type,uti,total_bytes)
             VALUES(30,'a30','/tmp/photo.heic','photo.heic','image/heic','public.heic',1234),
                   (31,'a31','/tmp/note.caf','note.caf','audio/x-caf','com.apple.coreaudio-format',4321);
             INSERT INTO message_attachment_join(message_id,attachment_id) VALUES(20,30),(20,31);`
        );
        expect(McpAttachmentMetadata.read({ attachmentId: 30 }).rows[0].downloadMimeType).toBe("image/jpeg");
        expect(McpAttachmentMetadata.read({ attachmentId: 31 }).rows[0].downloadMimeType).toBe("audio/mp3");
    });

    it("preserves exact 64-bit native timestamps in database-backed history ordering", async () => {
        execute(
            databasePath,
            `INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
             VALUES(10,'m10',800000000000000001,0,0,0,'ten','iMessage'),
                   (11,'m11',800000000000000001,0,0,0,'eleven','iMessage');`
        );

        const page = await McpMessageHistory.read({ limit: 2, anchorApple: "800000000000000002" });
        expect(page.rows.map(row => row.originalROWID)).toEqual([11, 10]);
        expect(page.rows.map(row => row.dateApple)).toEqual(["800000000000000001", "800000000000000001"]);
    });

    it("fails explicitly for an individually oversized or aggregate-oversized history response", async () => {
        execute(
            databasePath,
            `INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
             VALUES(1,'oversized',1,0,0,0,${sqlLiteral("x".repeat(MCP_HISTORY_RESPONSE_MAX_BYTES + 1))},'iMessage');`
        );
        await expect(McpMessageHistory.read({ limit: 1, anchorApple: "1000000000" })).rejects.toThrow(
            "One MCP history row exceeds the response byte limit"
        );

        execute(databasePath, "DELETE FROM message;");
        const inserts = ["BEGIN;"];
        for (let row = 1; row <= 101; row += 1) {
            inserts.push(
                `INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
                 VALUES(${row},'m${row}',${row},0,0,0,${sqlLiteral("y".repeat(45_000))},'iMessage');`
            );
        }
        inserts.push("COMMIT;");
        execute(databasePath, inserts.join("\n"));
        await expect(McpMessageHistory.read({ limit: 101, anchorApple: "200000000000" })).rejects.toThrow(
            "MCP history response exceeds the response byte limit"
        );
    });

    it("uses the exact worst-case event query bound while preserving high-water marks and fields", () => {
        const inserts = ["BEGIN;"];
        for (let row = 1; row <= 1250; row += 1) {
            inserts.push(`INSERT INTO handle(ROWID,id) VALUES(${row},'sender-${row}@example.invalid');`);
            inserts.push(`INSERT INTO chat(ROWID,guid,style) VALUES(${row},'iMessage;+;group-${row}',43);`);
            inserts.push(
                `INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,associated_message_guid,associated_message_emoji,cache_has_attachments,item_type,is_system_message,text,service)
                 VALUES(${row},'m${row}',${row},${row},${row % 2},${row === 1 ? 2000 : row === 2 ? 3000 : 0},${
                    row <= 2 ? "'p:root'" : "NULL"
                },${row === 1 ? "'thumbs-up'" : "NULL"},${row === 1 ? 1 : 0},0,0,'synthetic','iMessage');`
            );
            inserts.push(`INSERT INTO chat_message_join(chat_id,message_id) VALUES(${row},${row});`);
        }
        inserts.push("COMMIT;");
        execute(databasePath, inserts.join("\n"));
        database.queryCount = 0;

        const evidence = McpEventEvidence.read({
            after: 1000,
            pending: Array.from({ length: 1000 }, (_, index) => index + 1),
            limit: 250
        });

        expect(evidence.rows).toHaveLength(1250);
        expect(evidence.maximumRow).toBe(1250);
        expect(evidence.maximumChatRow).toBe(1250);
        expect(evidence.rows[0]).toMatchObject({
            associatedMessageType: 2000,
            associatedMessageGuid: "p:root",
            associatedMessageEmoji: "thumbs-up",
            cacheHasAttachments: true,
            sender: "sender-1@example.invalid",
            chats: [{ id: 1, guid: "iMessage;+;group-1" }]
        });
        expect(evidence.rows[1].associatedMessageType).toBe(3000);
        expect(database.queryCount).toBe(MCP_EVENT_MAX_SQL_QUERIES);
        expect(mcpSuccessResponseBytes(MCP_EVENT_SUCCESS_MESSAGE, evidence)).toBeLessThanOrEqual(
            MCP_EVENT_RESPONSE_MAX_BYTES
        );

        const baseline = McpEventEvidence.read({ after: 0, pending: [], limit: 0 });
        expect(baseline.rows).toEqual([]);
        expect(baseline.maximumRow).toBe(1250);
        expect(baseline.maximumChatRow).toBe(1250);
    });

    it("fails safely on event association and output overflow", () => {
        execute(
            databasePath,
            `INSERT INTO handle(ROWID,id) VALUES(1,${sqlLiteral("s".repeat(20_000))});
             INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
             VALUES(1,'m1',1,1,0,0,'synthetic','iMessage');`
        );
        const joins: string[] = [];
        for (let row = 1; row <= 130; row += 1) {
            joins.push(`INSERT INTO chat(ROWID,guid,style) VALUES(${row},'g${row}',43);`);
            joins.push(`INSERT INTO chat_message_join(chat_id,message_id) VALUES(${row},1);`);
        }
        execute(databasePath, joins.join("\n"));
        expect(() => McpEventEvidence.read({ after: 0, pending: [1], limit: 0 })).toThrow(
            "chat association limit exceeded"
        );

        execute(databasePath, "DELETE FROM chat_message_join; DELETE FROM chat;");
        const messages: string[] = [];
        for (let row = 2; row <= 250; row += 1) {
            messages.push(
                `INSERT INTO message(ROWID,guid,date,handle_id,is_from_me,associated_message_type,text,service)
                 VALUES(${row},'m${row}',${row},1,0,0,'synthetic','iMessage');`
            );
        }
        execute(databasePath, messages.join("\n"));
        expect(() => McpEventEvidence.read({ after: 0, pending: [], limit: 250 })).toThrow("response byte limit");
    });
});
