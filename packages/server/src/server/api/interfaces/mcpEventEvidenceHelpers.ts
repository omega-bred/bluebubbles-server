import { createHash } from "crypto";
import * as fs from "fs";
import { invalidMcpRequest } from "./mcpErrors";

export type McpEventEvidenceRequest = {
    after: number;
    pending: number[];
    limit: number;
};

export function validateMcpEventEvidenceRequest(body: unknown): McpEventEvidenceRequest {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
        invalidMcpRequest("Expected an event-evidence request object");
    }
    const request = body as Record<string, unknown>;
    if (Object.keys(request).some(key => !["after", "pending", "limit"].includes(key))) {
        invalidMcpRequest("Unsupported event-evidence request field");
    }
    const after = request.after ?? 0;
    const limit = request.limit ?? 0;
    const pending = request.pending ?? [];
    if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
        invalidMcpRequest("after must be a non-negative safe integer");
    }
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0 || limit > 250) {
        invalidMcpRequest("limit must be an integer from 0 through 250");
    }
    if (
        !Array.isArray(pending) ||
        pending.length > 1000 ||
        pending.some(value => !Number.isSafeInteger(value) || value < 0) ||
        new Set(pending).size !== pending.length
    ) {
        invalidMcpRequest("pending must contain at most 1000 unique non-negative safe integers");
    }
    return { after, limit, pending: pending as number[] };
}

export function pythonCompatibleSourceIdentityParts(resolvedPath: string, inode: bigint, birthtimeNs: bigint): string {
    // Python's stat.st_birthtime is a double. V8 and Python use the same
    // shortest round-trippable decimal representation for this finite value.
    const birthtime = Number(birthtimeNs) / 1_000_000_000;
    const material = `${resolvedPath}\0${inode.toString()}\0${birthtime.toString()}`;
    return `birth-v1:${createHash("sha256").update(material).digest("hex")}`;
}

export function pythonCompatibleSourceIdentity(databasePath: string): string {
    const resolved = fs.realpathSync(databasePath);
    const stat = fs.statSync(resolved, { bigint: true }) as fs.BigIntStats & { birthtimeNs?: bigint };
    const birthtimeNs = stat.birthtimeNs ?? BigInt(Math.round(Number(stat.birthtimeMs) * 1_000_000));
    return pythonCompatibleSourceIdentityParts(resolved, stat.ino, birthtimeNs);
}
