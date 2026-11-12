import { invalidMcpRequest } from "./mcpErrors";

export type McpChatExclusions = { excludeChatGuids: string[]; excludeChatRowIds: number[] };
export const MCP_CHAT_EXCLUSION_FIELDS = ["excludeChatGuids", "excludeChatRowIds"];

// Metadata only: safe to probe before any content-bearing operation. Do not infer
// support from a content response, or silently fall back to an unfiltered read.
export const MCP_CHAT_EXCLUSION_CAPABILITIES = {
    chatExclusionVersion: 1,
    chatExclusionOperations: ["history", "activity", "attachments", "transcribe"]
};

export function validateMcpChatExclusions(request: Record<string, unknown>): McpChatExclusions {
    const guids = request.excludeChatGuids === undefined ? [] : request.excludeChatGuids;
    const rowIds = request.excludeChatRowIds === undefined ? [] : request.excludeChatRowIds;
    if (
        !Array.isArray(guids) ||
        guids.length > 100 ||
        guids.some(
            value => typeof value !== "string" || value.length === 0 || value.length > 2048 || value !== value.trim()
        )
    )
        invalidMcpRequest("excludeChatGuids must contain at most 100 exact bounded chat GUIDs");
    if (
        !Array.isArray(rowIds) ||
        rowIds.length > 100 ||
        rowIds.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    )
        invalidMcpRequest("excludeChatRowIds must contain at most 100 positive safe integer chat ROWIDs");
    return {
        excludeChatGuids: Array.from(new Set(guids as string[])).sort(),
        excludeChatRowIds: Array.from(new Set(rowIds as number[])).sort((a, b) => a - b)
    };
}

// Exact chat identity, never participant matching. A message linked to any
// excluded chat stays excluded even if it is also linked to an allowed chat.
export function mcpExcludedMessagePredicate(
    request: McpChatExclusions,
    messageAlias: string,
    parameters: unknown[]
): string {
    const clauses: string[] = [];
    if (request.excludeChatGuids.length > 0) {
        clauses.push(`xc.guid IN (${request.excludeChatGuids.map(() => "?").join(",")})`);
        parameters.push(...request.excludeChatGuids);
    }
    if (request.excludeChatRowIds.length > 0) {
        clauses.push(`xc.ROWID IN (${request.excludeChatRowIds.map(() => "?").join(",")})`);
        parameters.push(...request.excludeChatRowIds.map(BigInt));
    }
    if (clauses.length === 0) return "1=1";
    return `NOT EXISTS (SELECT 1 FROM chat_message_join xj JOIN chat xc ON xc.ROWID=xj.chat_id
        WHERE xj.message_id=${messageAlias}.ROWID AND (${clauses.join(" OR ")}))`;
}

// Repeat the native selection guard in the ORM content query as well.
export function mcpExcludedMessageWhere(request: McpChatExclusions) {
    const parameters: unknown[] = [];
    let statement = mcpExcludedMessagePredicate(request, "message", parameters);
    const args: Record<string, unknown> = {};
    parameters.forEach((value, index) => {
        const name = `mcpExclusion${index}`;
        statement = statement.replace("?", `:${name}`);
        args[name] = typeof value === "bigint" ? Number(value) : value;
    });
    return { statement, args };
}

export function mcpExcludedAttachmentPredicate(
    request: McpChatExclusions,
    attachmentAlias: string,
    parameters: unknown[]
): string {
    const exclusion = mcpExcludedMessagePredicate(request, "xm", parameters);
    return `NOT EXISTS (SELECT 1 FROM message_attachment_join xaj JOIN message xm ON xm.ROWID=xaj.message_id
        WHERE xaj.attachment_id=${attachmentAlias}.ROWID AND NOT (${exclusion}))`;
}
