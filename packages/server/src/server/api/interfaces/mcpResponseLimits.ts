export const MCP_CHAT_SUCCESS_MESSAGE = "Successfully fetched exact MCP chat catalog!";
export const MCP_HISTORY_SUCCESS_MESSAGE = "Successfully fetched exact MCP message history!";
export const MCP_EVENT_SUCCESS_MESSAGE = "Successfully fetched exact MCP event evidence!";

export function mcpSuccessResponseBytes(message: string, data: unknown): number {
    return Buffer.byteLength(JSON.stringify({ status: 200, message, data }), "utf8");
}
