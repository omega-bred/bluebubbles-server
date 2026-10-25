import { Server } from "@server";
import {
    encodeMcpChatCatalogCursor,
    mcpChatCatalogSelection,
    validateMcpChatCatalogRequest
} from "./mcpChatCatalogHelpers";
import { MCP_CHAT_SUCCESS_MESSAGE, mcpSuccessResponseBytes } from "./mcpResponseLimits";

export const MCP_CHAT_PAGE_MAX_BYTES = 128 * 1024;

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
        nextCursor: string | null;
    } {
        const request = validateMcpChatCatalogRequest(body);
        const repository = Server().iMessageRepo;
        const database = (repository.db.driver as any).databaseConnection as SafeIntegerDatabase;
        if (!database?.prepare) throw new Error("Messages database connection is unavailable");
        const selection = mcpChatCatalogSelection(request);
        const selected = database
            .prepare(selection.sql)
            .safeIntegers(true)
            .all(...selection.parameters);
        const candidates = selected.slice(0, request.limit).map(row => ({
            originalROWID: exactNumber(row.row_id, "chat ROWID"),
            guid: String(row.guid),
            chatIdentifier: nullableText(row.chat_identifier),
            displayName: nullableText(row.display_name),
            roomName: nullableText(row.room_name),
            style: exactNumber(row.style, "chat style"),
            sortRank: exactNumber(row.sort_rank, "chat sort rank"),
            sortName: String(row.sort_name ?? "")
        }));
        const rows: typeof candidates = [];
        for (const row of candidates) {
            const prospectiveRows = rows.concat(row);
            const prospectiveHasMore = selected.length > prospectiveRows.length;
            const prospective = {
                rows: prospectiveRows.map(({ sortRank: _, sortName: __, ...value }) => value),
                nextCursor: prospectiveHasMore
                    ? encodeMcpChatCatalogCursor({
                          rank: row.sortRank,
                          name: row.sortName,
                          row: row.originalROWID
                      })
                    : null
            };
            if (mcpSuccessResponseBytes(MCP_CHAT_SUCCESS_MESSAGE, prospective) > MCP_CHAT_PAGE_MAX_BYTES) {
                if (rows.length === 0) throw new Error("One MCP chat row exceeds the response byte limit");
                break;
            }
            rows.push(row);
        }
        const hasMore = selected.length > rows.length;
        const last = hasMore ? rows[rows.length - 1] : null;
        const response = {
            rows: rows.map(({ sortRank: _, sortName: __, ...row }) => row),
            nextCursor:
                last == null
                    ? null
                    : encodeMcpChatCatalogCursor({
                          rank: last.sortRank,
                          name: last.sortName,
                          row: last.originalROWID
                      })
        };
        return response;
    }
}
