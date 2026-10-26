import { PhoneNumberFormat, PhoneNumberUtil } from "google-libphonenumber";

import { Server } from "@server";
import { invalidMcpRequest } from "@server/api/interfaces/mcpErrors";
import { MCP_ACTIVITY_SUCCESS_MESSAGE, mcpSuccessResponseBytes } from "@server/api/interfaces/mcpResponseLimits";

export const MCP_ACTIVITY_RESPONSE_MAX_BYTES = 128 * 1024;

type SafeIntegerStatement = {
    safeIntegers: (enabled?: boolean) => SafeIntegerStatement;
    all: (...parameters: unknown[]) => Record<string, unknown>[];
};

type SafeIntegerDatabase = {
    prepare: (sql: string) => SafeIntegerStatement;
};

const ATTACHMENT_FIELDS = ["transfer_name", "mime_type", "uti", "total_bytes", "is_sticker"];

function exactNumber(value: unknown, label: string): number {
    const result = Number(value ?? 0);
    if (!Number.isSafeInteger(result)) throw new Error(`${label} is outside JavaScript's safe integer range`);
    return result;
}

function nullableNumber(value: unknown, label: string): number | null {
    if (value == null) return null;
    return exactNumber(value, label);
}

function boundedText(value: unknown, maximum: number): string | null {
    return value == null ? null : String(value).slice(0, maximum);
}

function columns(database: SafeIntegerDatabase, table: string): Set<string> {
    return new Set(
        database
            .prepare(`PRAGMA table_info("${table}")`)
            .all()
            .map(row => String(row.name))
    );
}

function optionalField(available: Set<string>, alias: string, name: string): string {
    return available.has(name) ? `${alias}."${name}"` : "NULL";
}

function canonicalAddress(value: string, region: string): string | null {
    if (value.includes("@")) return value.toLocaleLowerCase();
    try {
        const phone = PhoneNumberUtil.getInstance();
        return phone.format(phone.parseAndKeepRawInput(value, region), PhoneNumberFormat.E164);
    } catch {
        return null;
    }
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

function participants(database: SafeIntegerDatabase, chatIds: number[]) {
    if (chatIds.length === 0) return new Map<number, { values: string[]; count: number }>();
    const marks = chatIds.map(() => "?").join(",");
    const rows = database
        .prepare(
            `WITH unique_participants AS (
                SELECT DISTINCT j.chat_id,h.id AS address
                FROM chat_handle_join j JOIN handle h ON h.ROWID=j.handle_id
                WHERE j.chat_id IN (${marks})
             ), ranked AS (
                SELECT chat_id,address,ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY address) AS rank,
                       COUNT(*) OVER (PARTITION BY chat_id) AS participant_count
                FROM unique_participants
             ) SELECT chat_id,address,participant_count FROM ranked WHERE rank<=51 ORDER BY chat_id,address`
        )
        .safeIntegers(true)
        .all(...chatIds.map(BigInt));
    const result = new Map<number, { values: string[]; count: number }>();
    for (const row of rows) {
        const chatId = exactNumber(row.chat_id, "chat ROWID");
        const entry = result.get(chatId) ?? {
            values: [],
            count: exactNumber(row.participant_count, "participant count")
        };
        if (entry.values.length < 50) entry.values.push(String(row.address));
        result.set(chatId, entry);
    }
    return result;
}

function attachments(database: SafeIntegerDatabase, messageIds: number[]) {
    const attachmentColumns = columns(database, "attachment");
    const joinColumns = columns(database, "message_attachment_join");
    const result = new Map<number, unknown>();
    if (attachmentColumns.size === 0 || !joinColumns.has("attachment_id") || !joinColumns.has("message_id")) {
        for (const messageId of messageIds) {
            result.set(messageId, { status: "unavailable_schema", items: [], truncated: false });
        }
        return result;
    }
    if (messageIds.length === 0) return result;
    const marks = messageIds.map(() => "?").join(",");
    const selected = ATTACHMENT_FIELDS.map(name => `${optionalField(attachmentColumns, "a", name)} AS "${name}"`).join(
        ","
    );
    const rows = database
        .prepare(
            `WITH ranked AS (
                SELECT j.message_id,a.ROWID AS attachment_id,${selected},
                       ROW_NUMBER() OVER (PARTITION BY j.message_id ORDER BY a.ROWID) AS rank
                FROM message_attachment_join j JOIN attachment a ON a.ROWID=j.attachment_id
                WHERE j.message_id IN (${marks})
             ) SELECT * FROM ranked WHERE rank<=21 ORDER BY message_id,attachment_id`
        )
        .safeIntegers(true)
        .all(...messageIds.map(BigInt));
    const grouped = new Map<number, Record<string, unknown>[]>();
    for (const row of rows) {
        const messageId = exactNumber(row.message_id, "message ROWID");
        const values = grouped.get(messageId) ?? [];
        values.push(row);
        grouped.set(messageId, values);
    }
    const missingColumns = ATTACHMENT_FIELDS.filter(name => !attachmentColumns.has(name)).sort();
    for (const messageId of messageIds) {
        const values = grouped.get(messageId) ?? [];
        result.set(messageId, {
            status: "ok",
            items: values.slice(0, 20).map(row => ({
                id: exactNumber(row.attachment_id, "attachment ROWID"),
                name: boundedText(row.transfer_name, 256),
                mimeType: boundedText(row.mime_type, 256),
                uti: boundedText(row.uti, 256),
                sizeBytesReported: nullableNumber(row.total_bytes, "attachment byte count"),
                isSticker: row.is_sticker == null ? null : Boolean(row.is_sticker)
            })),
            truncated: values.length > 20,
            missingColumns
        });
    }
    return result;
}

export class McpContactActivity {
    static async read(body: unknown) {
        const request = validate(body);
        const repository = Server().iMessageRepo;
        const database = (repository.db.driver as any).databaseConnection as SafeIntegerDatabase;
        if (!database?.prepare) throw new Error("Messages database connection is unavailable");
        const region = String(Server().region ?? "US");
        const requested = new Set(request.addresses);
        const handles = database.prepare("SELECT ROWID AS row_id,id AS address FROM handle").safeIntegers(true).all();
        const matchedAddresses = new Set<string>();
        const handleIds: number[] = [];
        for (const handle of handles) {
            const canonical = canonicalAddress(String(handle.address ?? ""), region);
            if (canonical == null || !requested.has(canonical)) continue;
            matchedAddresses.add(canonical);
            handleIds.push(exactNumber(handle.row_id, "handle ROWID"));
        }
        const unmatchedAddresses = request.addresses.filter(address => !matchedAddresses.has(address));
        if (handleIds.length === 0) {
            return McpContactActivity.bounded({
                rows: [],
                normalizationRegion: region,
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
            return McpContactActivity.bounded({
                rows: [],
                normalizationRegion: region,
                coverage: {
                    matchedHandleCount: handleIds.length,
                    matchedChatCount: 0,
                    unmatchedAddresses,
                    truncated: false
                }
            });
        }
        const messageColumns = columns(database, "message");
        const chatMarks = chatIds.map(() => "?").join(",");
        const dateApple = "(CASE WHEN ABS(m.date)<10000000000 THEN m.date*1000000000 ELSE m.date END)";
        const filters = ["m.date>0"];
        for (const name of ["item_type", "is_system_message", "date_retracted"]) {
            if (messageColumns.has(name)) filters.push(`COALESCE(m.${name},0)=0`);
        }
        const selected = database
            .prepare(
                `SELECT m.ROWID AS message_row,m.guid AS message_guid,${dateApple} AS date_apple,
                    m.is_from_me AS is_from_me,h.id AS sender_address,
                    c.ROWID AS chat_row,c.guid AS chat_guid,c.chat_identifier,c.display_name,c.room_name,c.style,
                    ${optionalField(messageColumns, "m", "associated_message_type")} AS associated_message_type,
                    ${optionalField(messageColumns, "m", "associated_message_guid")} AS associated_message_guid,
                    ${optionalField(messageColumns, "m", "associated_message_emoji")} AS associated_message_emoji,
                    ${optionalField(messageColumns, "m", "cache_has_attachments")} AS cache_has_attachments,
                    EXISTS(SELECT 1 FROM message_attachment_join a WHERE a.message_id=m.ROWID) AS has_attachments
                 FROM message m JOIN chat_message_join j ON j.message_id=m.ROWID
                 JOIN chat c ON c.ROWID=j.chat_id LEFT JOIN handle h ON h.ROWID=m.handle_id
                 WHERE c.ROWID IN (${chatMarks}) AND ${filters.join(" AND ")}
                 ORDER BY ${dateApple} DESC,m.ROWID DESC,c.ROWID DESC LIMIT ?`
            )
            .safeIntegers(true)
            .all(...chatIds.map(BigInt), request.limit + 1);
        const limited = selected.slice(0, request.limit);
        if (limited.length === 0) {
            return McpContactActivity.bounded({
                rows: [],
                normalizationRegion: region,
                coverage: {
                    matchedHandleCount: handleIds.length,
                    matchedChatCount: chatIds.length,
                    unmatchedAddresses,
                    truncated: false
                }
            });
        }
        const messageIds = Array.from(new Set(limited.map(row => exactNumber(row.message_row, "message ROWID"))));
        const [decodedMessages] = await repository.getMessages({
            limit: messageIds.length,
            withAttachments: false,
            where: [
                {
                    statement: "message.ROWID IN (:...mcpActivityIds)",
                    args: { mcpActivityIds: messageIds } as any
                }
            ]
        });
        const decodedById = new Map(decodedMessages.map(message => [message.ROWID, message]));
        const participantMap = participants(
            database,
            Array.from(new Set(limited.map(row => exactNumber(row.chat_row, "chat ROWID"))))
        );
        const attachmentMap = attachments(database, messageIds);
        const rows = limited.map(row => {
            const messageId = exactNumber(row.message_row, "message ROWID");
            const chatId = exactNumber(row.chat_row, "chat ROWID");
            const message = decodedById.get(messageId);
            if (message == null) throw new Error("Selected MCP activity row could not be decoded");
            const fullText = message.universalText(true);
            const participant = participantMap.get(chatId) ?? { values: [], count: 0 };
            const style = nullableNumber(row.style, "chat style");
            const identifier = boundedText(row.chat_identifier, 512);
            const roomName = boundedText(row.room_name, 512);
            const group =
                style === 43 || participant.count > 1 || Boolean(roomName) || Boolean(identifier?.startsWith("chat"));
            return {
                messageId,
                messageGuid: boundedText(row.message_guid, 512),
                dateApple: String(row.date_apple),
                isFromMe: Boolean(row.is_from_me),
                senderAddress: Boolean(row.is_from_me) ? null : boundedText(row.sender_address, 320),
                text: boundedText(fullText, 4000),
                textStatus:
                    message.text != null
                        ? "plain_text"
                        : fullText != null
                        ? "decoded_attributed_body"
                        : messageColumns.has("attributedBody")
                        ? "decode_failed"
                        : "unavailable_column",
                textTruncated: fullText != null && fullText.length > 4000,
                hasAttachments:
                    row.cache_has_attachments == null
                        ? Boolean(row.has_attachments)
                        : Boolean(row.cache_has_attachments),
                attachments: attachmentMap.get(messageId),
                associatedMessageType: nullableNumber(row.associated_message_type, "associated message type"),
                associatedMessageGuid: boundedText(row.associated_message_guid, 512),
                associatedMessageEmoji: boundedText(row.associated_message_emoji, 128),
                chat: {
                    id: chatId,
                    guid: boundedText(row.chat_guid, 2048),
                    identifier,
                    name: boundedText(row.display_name, 512),
                    type: group ? "group" : "direct",
                    participants: participant.values,
                    participantCount: participant.count,
                    participantsTruncated: participant.count > 50
                }
            };
        });
        return McpContactActivity.bounded({
            rows,
            normalizationRegion: region,
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
