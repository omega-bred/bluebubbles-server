import { Server } from "@server";
import { invalidMcpRequest } from "@server/api/interfaces/mcpErrors";
import { MCP_ATTACHMENT_SUCCESS_MESSAGE, mcpSuccessResponseBytes } from "@server/api/interfaces/mcpResponseLimits";

export const MCP_ATTACHMENT_RESPONSE_MAX_BYTES = 256 * 1024;

type SafeIntegerStatement = {
    safeIntegers: (enabled?: boolean) => SafeIntegerStatement;
    all: (...parameters: unknown[]) => Record<string, unknown>[];
};

type SafeIntegerDatabase = {
    prepare: (sql: string) => SafeIntegerStatement;
};

type Request = {
    attachmentId: number | null;
    startApple: bigint | null;
    endApple: bigint | null;
    contactAddress: string | null;
    mimeType: string | null;
    limit: number;
};

const INTEGER64_MAX = BigInt("9223372036854775807");

function exactNumber(value: unknown, label: string): number {
    const result = Number(value ?? 0);
    if (!Number.isSafeInteger(result)) throw new Error(`${label} is outside JavaScript's safe integer range`);
    return result;
}

function appleInteger(request: Record<string, unknown>, name: string): bigint | null {
    const value = request[name];
    if (value == null) return null;
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        invalidMcpRequest(`${name} must be a canonical non-negative 64-bit integer string`);
    }
    const parsed = BigInt(value);
    if (parsed > INTEGER64_MAX) invalidMcpRequest(`${name} is outside the signed 64-bit range`);
    return parsed;
}

function optionalString(request: Record<string, unknown>, name: string, maximum: number): string | null {
    const value = request[name];
    if (value == null) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim()) {
        invalidMcpRequest(`${name} must be a bounded string without surrounding whitespace`);
    }
    return value;
}

function validate(body: unknown): Request {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
        invalidMcpRequest("Expected an MCP attachment-metadata request object");
    }
    const request = body as Record<string, unknown>;
    const supported = ["attachmentId", "startApple", "endApple", "contactAddress", "mimeType", "limit"];
    if (Object.keys(request).some(key => !supported.includes(key))) {
        invalidMcpRequest("Unsupported MCP attachment-metadata request field");
    }
    const attachmentValue = request.attachmentId;
    const attachmentId = attachmentValue == null ? null : attachmentValue;
    if (
        attachmentId != null &&
        (typeof attachmentId !== "number" || !Number.isSafeInteger(attachmentId) || attachmentId < 1)
    ) {
        invalidMcpRequest("attachmentId must be a positive safe integer");
    }
    const startApple = appleInteger(request, "startApple");
    const endApple = appleInteger(request, "endApple");
    if (startApple != null && endApple != null && startApple >= endApple) {
        invalidMcpRequest("startApple must be earlier than endApple");
    }
    const contactAddress = optionalString(request, "contactAddress", 320);
    if (
        contactAddress != null &&
        !/^[^@\s<>]+@[^@\s<>]+$/u.test(contactAddress) &&
        !/^\+[1-9][0-9]{7,14}$/.test(contactAddress)
    ) {
        invalidMcpRequest("contactAddress must be canonical E.164 or an email address");
    }
    const mimeType = optionalString(request, "mimeType", 256);
    const limit = request.limit ?? 50;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        invalidMcpRequest("limit must be an integer from 1 through 100");
    }
    if (
        attachmentId != null &&
        (startApple != null || endApple != null || contactAddress != null || mimeType != null || request.limit != null)
    ) {
        invalidMcpRequest("attachmentId lookup cannot be combined with search filters");
    }
    return {
        attachmentId: attachmentId == null ? null : Number(attachmentId),
        startApple,
        endApple,
        contactAddress,
        mimeType,
        limit: attachmentId == null ? Number(limit) : 1
    };
}

function escapeLike(value: string): string {
    return value.replace(/\\/gu, "\\\\").replace(/%/gu, "\\%").replace(/_/gu, "\\_");
}

function downloadMimeType(mimeType: string | null, uti: string | null): string | null {
    const mime = (mimeType ?? "").toLocaleLowerCase();
    const uniformType = (uti ?? "").toLocaleLowerCase();
    if (
        uniformType === "public.heic" ||
        uniformType === "public.heif" ||
        uniformType === "public.tiff" ||
        mime.startsWith("image/heic") ||
        mime.startsWith("image/heif") ||
        mime.startsWith("image/tiff") ||
        mime.endsWith("tif")
    ) {
        return "image/jpeg";
    }
    if (uniformType === "com.apple.coreaudio-format" || mime === "audio/x-caf") return "audio/mp3";
    return mimeType;
}

export class McpAttachmentMetadata {
    static read(body: unknown) {
        const request = validate(body);
        const database = (Server().iMessageRepo.db.driver as any).databaseConnection as SafeIntegerDatabase;
        if (!database?.prepare) throw new Error("Messages database connection is unavailable");
        const dateApple = "(CASE WHEN ABS(m.date)<10000000000 THEN m.date*1000000000 ELSE m.date END)";
        const clauses: string[] = [];
        const parameters: unknown[] = [];
        if (request.attachmentId != null) {
            clauses.push("a.ROWID=?");
            parameters.push(BigInt(request.attachmentId));
        }
        if (request.startApple != null) {
            clauses.push(`${dateApple}>=?`);
            parameters.push(request.startApple);
        }
        if (request.endApple != null) {
            clauses.push(`${dateApple}<?`);
            parameters.push(request.endApple);
        }
        if (request.contactAddress != null) {
            if (request.contactAddress.includes("@")) {
                clauses.push("m.handle_id IN (SELECT ROWID FROM handle WHERE id=? COLLATE NOCASE)");
                parameters.push(request.contactAddress);
            } else {
                clauses.push(
                    "m.handle_id IN (SELECT ROWID FROM handle WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(id,'+',''),' ',''),'-',''),'(',''),')',''),'.','')=?)"
                );
                parameters.push(request.contactAddress.slice(1));
            }
        }
        if (request.mimeType != null) {
            clauses.push("COALESCE(a.mime_type,'') LIKE ? ESCAPE '\\'");
            parameters.push(`${escapeLike(request.mimeType.replace(/\*$/u, ""))}%`);
        }
        parameters.push(request.limit);
        const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
        const selected = database
            .prepare(
                `SELECT a.ROWID AS attachment_row,a.guid AS attachment_guid,a.filename AS file_path,a.transfer_name,a.mime_type,a.uti,
                    a.total_bytes,m.ROWID AS message_row,m.guid AS message_guid,${dateApple} AS date_apple,
                    m.is_from_me AS is_from_me
                 FROM message_attachment_join j JOIN attachment a ON a.ROWID=j.attachment_id
                 JOIN message m ON m.ROWID=j.message_id ${where}
                 ORDER BY ${dateApple} DESC,m.ROWID DESC,a.ROWID DESC LIMIT ?`
            )
            .safeIntegers(true)
            .all(...parameters);
        const rows = selected.map(row => {
            const mimeType = row.mime_type == null ? null : String(row.mime_type);
            const uti = row.uti == null ? null : String(row.uti);
            return {
                attachmentId: exactNumber(row.attachment_row, "attachment ROWID"),
                attachmentGuid: row.attachment_guid == null ? null : String(row.attachment_guid),
                filePath: row.file_path == null ? null : String(row.file_path),
                filename: row.transfer_name == null ? null : String(row.transfer_name),
                mimeType,
                uti,
                downloadMimeType: downloadMimeType(mimeType, uti),
                totalBytes: exactNumber(row.total_bytes, "attachment byte count"),
                messageId: exactNumber(row.message_row, "message ROWID"),
                messageGuid: row.message_guid == null ? null : String(row.message_guid),
                dateApple: String(row.date_apple),
                isFromMe: Boolean(row.is_from_me)
            };
        });
        const response = { rows };
        if (mcpSuccessResponseBytes(MCP_ATTACHMENT_SUCCESS_MESSAGE, response) > MCP_ATTACHMENT_RESPONSE_MAX_BYTES) {
            throw new Error("MCP attachment-metadata response exceeds the response byte limit");
        }
        return response;
    }
}
