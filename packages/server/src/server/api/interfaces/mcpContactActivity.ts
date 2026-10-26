import { Server } from "@server";
import { invalidMcpRequest } from "@server/api/interfaces/mcpErrors";
import { MCP_ACTIVITY_SUCCESS_MESSAGE, mcpSuccessResponseBytes } from "@server/api/interfaces/mcpResponseLimits";

export { McpContactActivity } from "@server/api/interfaces/mcpContactActivityDetails";

export const MCP_ACTIVITY_RESPONSE_MAX_BYTES = 128 * 1024;

type SafeIntegerStatement = {
    safeIntegers: (enabled?: boolean) => SafeIntegerStatement;
    all: (...parameters: unknown[]) => Record<string, unknown>[];
};

type SafeIntegerDatabase = {
    prepare: (sql: string) => SafeIntegerStatement;
};

function exactNumber(value: unknown, label: string): number {
    const result = Number(value ?? 0);
    if (!Number.isSafeInteger(result)) throw new Error(`${label} is outside JavaScript's safe integer range`);
    return result;
}

function addressMatches(requested: string, stored: string): boolean {
    if (requested.includes("@") || stored.includes("@")) {
        return requested.toLocaleLowerCase() === stored.toLocaleLowerCase();
    }
    const expectedDigits = requested.replace(/\D/gu, "");
    const storedDigits = stored.replace(/\D/gu, "");
    return storedDigits.length >= 7 && (expectedDigits === storedDigits || expectedDigits.endsWith(storedDigits));
}

function validate(body: unknown): { addresses: string[]; limit: number } {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
        invalidMcpRequest("Expected an MCP contact-activity request object");
    }
    const request = body as Record<string, unknown>;
    if (Object.keys(request).some(key => !["addresses", "limit"].includes(key))) {
        invalidMcpRequest("Unsupported MCP contact-activity request field");
    }
    if (!Array.isArray(request.addresses) || request.addresses.length < 1 || request.addresses.length > 32) {
        invalidMcpRequest("addresses must contain 1 through 32 exact phone or email values");
    }
    const addresses = Array.from(
        new Set(
            request.addresses.map(value => {
                if (
                    typeof value !== "string" ||
                    value.length === 0 ||
                    value.length > 320 ||
                    value !== value.trim() ||
                    (!/^[^@\s<>]+@[^@\s<>]+$/u.test(value) && !/^\+[1-9][0-9]{7,14}$/.test(value))
                ) {
                    invalidMcpRequest("addresses must be canonical E.164 or email values");
                }
                return value.includes("@") ? value.toLocaleLowerCase() : value;
            })
        )
    );
    const limit = request.limit ?? 1;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        invalidMcpRequest("limit must be an integer from 1 through 20");
    }
    return { addresses, limit };
}

class LegacyMcpContactActivity {
    static read(body: unknown) {
        const request = validate(body);
        const database = (Server().iMessageRepo.db.driver as any).databaseConnection as SafeIntegerDatabase;
        if (!database?.prepare) throw new Error("Messages database connection is unavailable");
        const handles = database.prepare("SELECT ROWID AS row_id,id AS address FROM handle").safeIntegers(true).all();
        const matchedAddresses = new Set<string>();
        const handleIds: number[] = [];
        for (const handle of handles) {
            const address = String(handle.address ?? "");
            const canonical = request.addresses.find(value => addressMatches(value, address));
            if (canonical == null) continue;
            matchedAddresses.add(canonical);
            handleIds.push(exactNumber(handle.row_id, "handle ROWID"));
        }
        const unmatchedAddresses = request.addresses.filter(address => !matchedAddresses.has(address));
        if (handleIds.length === 0) {
            return LegacyMcpContactActivity.bounded({
                rows: [],
                coverage: {
                    matchedHandleCount: 0,
                    matchedChatCount: 0,
                    unmatchedAddresses,
                    truncated: false
                }
            });
        }
        const marks = handleIds.map(() => "?").join(",");
        const chats = database
            .prepare(`SELECT DISTINCT chat_id FROM chat_handle_join WHERE handle_id IN (${marks})`)
            .safeIntegers(true)
            .all(...handleIds.map(BigInt));
        const chatIds = chats.map(row => exactNumber(row.chat_id, "chat ROWID"));
        if (chatIds.length === 0) {
            return LegacyMcpContactActivity.bounded({
                rows: [],
                coverage: {
                    matchedHandleCount: handleIds.length,
                    matchedChatCount: 0,
                    unmatchedAddresses,
                    truncated: false
                }
            });
        }
        const chatMarks = chatIds.map(() => "?").join(",");
        const dateApple = "(CASE WHEN ABS(m.date)<10000000000 THEN m.date*1000000000 ELSE m.date END)";
        const selected = database
            .prepare(
                `SELECT m.ROWID AS message_row,m.guid AS message_guid,${dateApple} AS date_apple,
                    m.is_from_me AS is_from_me,c.ROWID AS chat_row,c.guid AS chat_guid,
                    EXISTS(SELECT 1 FROM message_attachment_join a WHERE a.message_id=m.ROWID) AS has_attachments
                 FROM message m JOIN chat_message_join j ON j.message_id=m.ROWID
                 JOIN chat c ON c.ROWID=j.chat_id
                 WHERE c.ROWID IN (${chatMarks}) AND m.date>0
                 ORDER BY ${dateApple} DESC,m.ROWID DESC,c.ROWID DESC LIMIT ?`
            )
            .safeIntegers(true)
            .all(...chatIds.map(BigInt), request.limit + 1);
        const rows = selected.slice(0, request.limit).map(row => ({
            messageId: exactNumber(row.message_row, "message ROWID"),
            messageGuid: row.message_guid == null ? null : String(row.message_guid),
            dateApple: String(row.date_apple),
            isFromMe: Boolean(row.is_from_me),
            hasAttachments: Boolean(row.has_attachments),
            chatId: exactNumber(row.chat_row, "chat ROWID"),
            chatGuid: row.chat_guid == null ? null : String(row.chat_guid)
        }));
        return LegacyMcpContactActivity.bounded({
            rows,
            coverage: {
                matchedHandleCount: handleIds.length,
                matchedChatCount: chatIds.length,
                unmatchedAddresses,
                truncated: selected.length > request.limit
            }
        });
    }

    private static bounded<T>(response: T): T {
        if (mcpSuccessResponseBytes(MCP_ACTIVITY_SUCCESS_MESSAGE, response) > MCP_ACTIVITY_RESPONSE_MAX_BYTES) {
            throw new Error("MCP contact-activity response exceeds the response byte limit");
        }
        return response;
    }
}
