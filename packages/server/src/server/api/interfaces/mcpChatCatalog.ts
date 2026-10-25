import { Server } from "@server";
import { mcpChatCatalogSelection, validateMcpChatCatalogRequest } from "./mcpChatCatalogHelpers";

type SafeIntegerStatement = {
    safeIntegers: (enabled?: boolean) => SafeIntegerStatement;
    all: (...parameters: unknown[]) => Record<string, unknown>[];
};

type SafeIntegerDatabase = {
    prepare: (sql: string) => SafeIntegerStatement;
};

function exactNumber(value: unknown, label: string): number {
    const result = typeof value === "bigint" ? Number(value) : Number(value);
    if (!Number.isSafeInteger(result)) throw new Error(`${label} is outside JavaScript's safe integer range`);
    return result;
}

function nullableText(value: unknown): string | null {
    return value == null ? null : String(value);
}

export class McpChatCatalog {
    static read(body: unknown): {
        rows: Array<{
            originalROWID: number;
            guid: string;
            chatIdentifier: string | null;
            displayName: string | null;
            roomName: string | null;
            style: number;
        }>;
    } {
        const request = validateMcpChatCatalogRequest(body);
        const repository = Server().iMessageRepo;
        const database = (repository.db.driver as any).databaseConnection as SafeIntegerDatabase;
        if (!database?.prepare) throw new Error("Messages database connection is unavailable");
        const selection = mcpChatCatalogSelection(request);
        const rows = database.prepare(selection.sql).safeIntegers(true).all(...selection.parameters);
        return {
            rows: rows.map(row => ({
                originalROWID: exactNumber(row.row_id, "chat ROWID"),
                guid: String(row.guid),
                chatIdentifier: nullableText(row.chat_identifier),
                displayName: nullableText(row.display_name),
                roomName: nullableText(row.room_name),
                style: exactNumber(row.style, "chat style")
            }))
        };
    }
}
