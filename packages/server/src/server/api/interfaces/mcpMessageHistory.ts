import { Server } from "@server";
import {
    McpMessageHistoryRequest,
    mcpMessageHistorySelection,
    validateMcpMessageHistoryRequest
} from "@server/api/interfaces/mcpMessageHistoryHelpers";
import { MCP_HISTORY_SUCCESS_MESSAGE, mcpSuccessResponseBytes } from "@server/api/interfaces/mcpResponseLimits";
import { McpMatchingBudget, messageSimilarity } from "@server/api/interfaces/mcpMatchingHelpers";

export type { McpMessageHistoryRequest };

export const MCP_HISTORY_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

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

export class McpMessageHistory {
    static async read(body: unknown): Promise<{
        rows: Array<{
            originalROWID: number;
            guid: string | null;
            dateApple: string;
            isFromMe: boolean;
            text: string | null;
            service: string | null;
            score?: number;
            matches?: boolean;
        }>;
    }> {
        const request = validateMcpMessageHistoryRequest(body);
        const repository = Server().iMessageRepo;
        const database = (repository.db.driver as any).databaseConnection as SafeIntegerDatabase;
        if (!database?.prepare) throw new Error("Messages database connection is unavailable");
        const selection = mcpMessageHistorySelection(request);
        const selected = database
            .prepare(selection.sql)
            .safeIntegers(true)
            .all(...selection.parameters);
        if (selected.length === 0) return { rows: [] };
        const ids = selected.map(row => exactNumber(row.row_id, "message ROWID"));
        const [messages] = await repository.getMessages({
            limit: ids.length,
            withAttachments: false,
            where: [
                {
                    statement: "message.ROWID IN (:...mcpHistoryIds)",
                    args: { mcpHistoryIds: ids } as any
                }
            ]
        });
        const byId = new Map(messages.map(message => [message.ROWID, message]));
        const matchingBudget = new McpMatchingBudget();
        const rows = selected.map(row => {
            const rowId = exactNumber(row.row_id, "message ROWID");
            const message = byId.get(rowId);
            if (!message) throw new Error("Selected MCP history row could not be decoded");
            const result: {
                originalROWID: number;
                guid: string | null;
                dateApple: string;
                isFromMe: boolean;
                text: string | null;
                service: string | null;
                score?: number;
                matches?: boolean;
            } = {
                originalROWID: rowId,
                guid: message.guid ?? null,
                dateApple: String(row.date_apple),
                isFromMe: Boolean(message.isFromMe),
                text: message.universalText(true),
                service: message.service ?? null
            };
            if (request.searchTerm != null && request.threshold != null) {
                result.score = messageSimilarity(request.searchTerm, result.text, matchingBudget);
                result.matches = result.score >= request.threshold;
            }
            return result;
        });
        for (const row of rows) {
            if (
                mcpSuccessResponseBytes(MCP_HISTORY_SUCCESS_MESSAGE, { rows: [row] }) > MCP_HISTORY_RESPONSE_MAX_BYTES
            ) {
                throw new Error("One MCP history row exceeds the response byte limit");
            }
        }
        const response = { rows };
        if (mcpSuccessResponseBytes(MCP_HISTORY_SUCCESS_MESSAGE, response) > MCP_HISTORY_RESPONSE_MAX_BYTES) {
            throw new Error("MCP history response exceeds the response byte limit");
        }
        return response;
    }
}
