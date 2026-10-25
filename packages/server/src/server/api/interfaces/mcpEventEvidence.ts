import * as path from "path";

import { Server } from "@server";
import {
    McpEventEvidenceRequest,
    pythonCompatibleSourceIdentity,
    validateMcpEventEvidenceRequest
} from "@server/api/interfaces/mcpEventEvidenceHelpers";

export type { McpEventEvidenceRequest };

export type McpEventEvidenceChat = {
    id: number;
    guid: string | null;
};

export type McpEventEvidenceRow = {
    originalROWID: number;
    guid: string | null;
    dateApple: string;
    isFromMe: boolean;
    associatedMessageType: number;
    associatedMessageGuid: string | null;
    associatedMessageEmoji: string | null;
    cacheHasAttachments: boolean;
    itemType: number;
    isSystemMessage: boolean;
    sender: string | null;
    chats: McpEventEvidenceChat[];
};

type SafeIntegerStatement = {
    safeIntegers: (enabled?: boolean) => SafeIntegerStatement;
    all: (...parameters: unknown[]) => Record<string, unknown>[];
    get: (...parameters: unknown[]) => Record<string, unknown> | undefined;
};

type SafeIntegerDatabase = {
    prepare: (sql: string) => SafeIntegerStatement;
};

const REQUIRED_COLUMNS = [
    "guid",
    "date",
    "handle_id",
    "is_from_me",
    "associated_message_type",
    "associated_message_guid"
];

const OPTIONAL_COLUMNS = [
    "associated_message_emoji",
    "cache_has_attachments",
    "item_type",
    "is_system_message"
];

function exactNumber(value: unknown, label: string): number {
    const result = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
    if (!Number.isSafeInteger(result)) throw new Error(`${label} is outside JavaScript's safe integer range`);
    return result;
}

function nullableText(value: unknown): string | null {
    return value == null ? null : String(value);
}

export class McpEventEvidence {
    static read(body: unknown): {
        sourceIdentity: string;
        maximumRow: number;
        maximumChatRow: number;
        rows: McpEventEvidenceRow[];
    } {
        const request = validateMcpEventEvidenceRequest(body);
        const repository = Server().iMessageRepo;
        const databasePath = path.resolve(repository.dbPath);
        const database = (repository.db.driver as any).databaseConnection as SafeIntegerDatabase;
        if (!database?.prepare) throw new Error("Messages database connection is unavailable");

        const columns = new Set(
            database
                .prepare("PRAGMA table_info(message)")
                .safeIntegers(true)
                .all()
                .map(row => String(row.name))
        );
        if (REQUIRED_COLUMNS.some(column => !columns.has(column))) {
            throw new Error("Messages schema does not support exact MCP event evidence");
        }
        const selectedColumns = REQUIRED_COLUMNS.concat(OPTIONAL_COLUMNS.filter(column => columns.has(column)));
        const fields = selectedColumns.map(column => `m."${column}"`).join(",");
        const selected = new Map<number, Record<string, unknown>>();
        if (request.limit > 0) {
            const rows = database
                .prepare(
                    `SELECT m.ROWID AS row_id,${fields} FROM message m WHERE m.ROWID>? ORDER BY m.ROWID LIMIT ?`
                )
                .safeIntegers(true)
                .all(BigInt(request.after), BigInt(request.limit));
            rows.forEach(row => selected.set(exactNumber(row.row_id, "message ROWID"), row));
        }
        for (let offset = 0; offset < request.pending.length; offset += 500) {
            const batch = request.pending.slice(offset, offset + 500);
            if (batch.length === 0) continue;
            const marks = batch.map(() => "?").join(",");
            const rows = database
                .prepare(`SELECT m.ROWID AS row_id,${fields} FROM message m WHERE m.ROWID IN (${marks})`)
                .safeIntegers(true)
                .all(...batch.map(BigInt));
            rows.forEach(row => selected.set(exactNumber(row.row_id, "message ROWID"), row));
        }

        const maximum = database
            .prepare("SELECT COALESCE(MAX(ROWID),0) AS maximum_row FROM message")
            .safeIntegers(true)
            .get();
        const maximumChat = database
            .prepare("SELECT COALESCE(MAX(ROWID),0) AS maximum_row FROM chat")
            .safeIntegers(true)
            .get();
        const rows = Array.from(selected.entries())
            .sort(([left], [right]) => left - right)
            .map(([rowId, row]) => McpEventEvidence.serializeRow(database, rowId, row));
        return {
            sourceIdentity: pythonCompatibleSourceIdentity(databasePath),
            maximumRow: exactNumber(maximum?.maximum_row, "maximum message ROWID"),
            maximumChatRow: exactNumber(maximumChat?.maximum_row, "maximum chat ROWID"),
            rows
        };
    }

    private static serializeRow(
        database: SafeIntegerDatabase,
        rowId: number,
        row: Record<string, unknown>
    ): McpEventEvidenceRow {
        const chats = database
            .prepare(
                "SELECT DISTINCT c.ROWID AS id,c.guid FROM chat c JOIN chat_message_join j ON j.chat_id=c.ROWID WHERE j.message_id=? ORDER BY c.ROWID LIMIT 129"
            )
            .safeIntegers(true)
            .all(BigInt(rowId))
            .map(chat => ({ id: exactNumber(chat.id, "chat ROWID"), guid: nullableText(chat.guid) }));
        const handleId = exactNumber(row.handle_id, "handle ROWID");
        const handle =
            handleId === 0
                ? undefined
                : database
                      .prepare("SELECT id FROM handle WHERE ROWID=?")
                      .safeIntegers(true)
                      .get(BigInt(handleId));
        return {
            originalROWID: rowId,
            guid: nullableText(row.guid),
            dateApple: String(row.date ?? 0),
            isFromMe: Boolean(row.is_from_me),
            associatedMessageType: exactNumber(row.associated_message_type, "associated message type"),
            associatedMessageGuid: nullableText(row.associated_message_guid),
            associatedMessageEmoji: nullableText(row.associated_message_emoji),
            cacheHasAttachments: Boolean(row.cache_has_attachments),
            itemType: exactNumber(row.item_type, "message item type"),
            isSystemMessage: Boolean(row.is_system_message),
            sender: nullableText(handle?.id),
            chats
        };
    }
}
