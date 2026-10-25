import * as path from "path";

import { Server } from "@server";
import {
    McpEventEvidenceRequest,
    pythonCompatibleSourceIdentity,
    validateMcpEventEvidenceRequest
} from "@server/api/interfaces/mcpEventEvidenceHelpers";
import { MCP_EVENT_SUCCESS_MESSAGE, mcpSuccessResponseBytes } from "@server/api/interfaces/mcpResponseLimits";

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

const OPTIONAL_COLUMNS = ["associated_message_emoji", "cache_has_attachments", "item_type", "is_system_message"];

const SQL_BATCH_SIZE = 500;
const MAX_CHATS_PER_MESSAGE = 129;
export const MCP_EVENT_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const MCP_EVENT_MAX_SQL_QUERIES = 12;

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
                .prepare(`SELECT m.ROWID AS row_id,${fields} FROM message m WHERE m.ROWID>? ORDER BY m.ROWID LIMIT ?`)
                .safeIntegers(true)
                .all(BigInt(request.after), BigInt(request.limit));
            rows.forEach(row => selected.set(exactNumber(row.row_id, "message ROWID"), row));
        }
        for (let offset = 0; offset < request.pending.length; offset += SQL_BATCH_SIZE) {
            const batch = request.pending.slice(offset, offset + SQL_BATCH_SIZE);
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
        const entries = Array.from(selected.entries()).sort(([left], [right]) => left - right);
        const chats = McpEventEvidence.loadChats(
            database,
            entries.map(([rowId]) => rowId)
        );
        const handles = McpEventEvidence.loadHandles(
            database,
            entries.map(([, row]) => exactNumber(row.handle_id, "handle ROWID")).filter(handleId => handleId !== 0)
        );
        const rows = entries.map(([rowId, row]) => McpEventEvidence.serializeRow(rowId, row, chats, handles));
        const response = {
            sourceIdentity: pythonCompatibleSourceIdentity(databasePath),
            maximumRow: exactNumber(maximum?.maximum_row, "maximum message ROWID"),
            maximumChatRow: exactNumber(maximumChat?.maximum_row, "maximum chat ROWID"),
            rows
        };
        if (mcpSuccessResponseBytes(MCP_EVENT_SUCCESS_MESSAGE, response) > MCP_EVENT_RESPONSE_MAX_BYTES) {
            throw new Error("MCP event evidence exceeds the response byte limit");
        }
        return response;
    }

    private static loadChats(database: SafeIntegerDatabase, rowIds: number[]): Map<number, McpEventEvidenceChat[]> {
        const result = new Map<number, McpEventEvidenceChat[]>();
        for (let offset = 0; offset < rowIds.length; offset += SQL_BATCH_SIZE) {
            const batch = rowIds.slice(offset, offset + SQL_BATCH_SIZE);
            if (batch.length === 0) continue;
            const marks = batch.map(() => "?").join(",");
            const rows = database
                .prepare(
                    `SELECT message_id,id,guid FROM (
                        SELECT j.message_id AS message_id,c.ROWID AS id,c.guid AS guid,
                            ROW_NUMBER() OVER (PARTITION BY j.message_id ORDER BY c.ROWID) AS position
                        FROM chat_message_join j JOIN chat c ON c.ROWID=j.chat_id
                        WHERE j.message_id IN (${marks})
                    ) WHERE position<=? ORDER BY message_id,id`
                )
                .safeIntegers(true)
                .all(...batch.map(BigInt), MAX_CHATS_PER_MESSAGE + 1);
            for (const row of rows) {
                const messageId = exactNumber(row.message_id, "message ROWID");
                const values = result.get(messageId) ?? [];
                if (values.length >= MAX_CHATS_PER_MESSAGE) {
                    throw new Error("MCP event evidence chat association limit exceeded");
                }
                values.push({ id: exactNumber(row.id, "chat ROWID"), guid: nullableText(row.guid) });
                result.set(messageId, values);
            }
        }
        return result;
    }

    private static loadHandles(database: SafeIntegerDatabase, handleIds: number[]): Map<number, string | null> {
        const result = new Map<number, string | null>();
        const unique = Array.from(new Set(handleIds));
        for (let offset = 0; offset < unique.length; offset += SQL_BATCH_SIZE) {
            const batch = unique.slice(offset, offset + SQL_BATCH_SIZE);
            if (batch.length === 0) continue;
            const marks = batch.map(() => "?").join(",");
            const rows = database
                .prepare(`SELECT ROWID AS handle_row,id AS address FROM handle WHERE ROWID IN (${marks})`)
                .safeIntegers(true)
                .all(...batch.map(BigInt));
            rows.forEach(row => result.set(exactNumber(row.handle_row, "handle ROWID"), nullableText(row.address)));
        }
        return result;
    }

    private static serializeRow(
        rowId: number,
        row: Record<string, unknown>,
        chats: Map<number, McpEventEvidenceChat[]>,
        handles: Map<number, string | null>
    ): McpEventEvidenceRow {
        const handleId = exactNumber(row.handle_id, "handle ROWID");
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
            sender: handleId === 0 ? null : handles.get(handleId) ?? null,
            chats: chats.get(rowId) ?? []
        };
    }
}
