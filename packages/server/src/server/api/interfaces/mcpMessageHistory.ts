import { Server } from "@server";
import {
    McpMessageHistoryRequest,
    mcpMessageHistorySelection,
    validateMcpMessageHistoryRequest
} from "@server/api/interfaces/mcpMessageHistoryHelpers";

export type { McpMessageHistoryRequest };

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
        return {
            rows: selected.map(row => {
                const rowId = exactNumber(row.row_id, "message ROWID");
                const message = byId.get(rowId);
                if (!message) throw new Error("Selected MCP history row could not be decoded");
                return {
                    originalROWID: rowId,
                    guid: message.guid ?? null,
                    dateApple: String(row.date_apple),
                    isFromMe: Boolean(message.isFromMe),
                    text: message.universalText(true),
                    service: message.service ?? null
                };
            })
        };
    }
}
