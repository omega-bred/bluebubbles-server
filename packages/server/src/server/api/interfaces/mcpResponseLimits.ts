export const MCP_CHAT_SUCCESS_MESSAGE = "Successfully fetched exact MCP chat catalog!";
export const MCP_HISTORY_SUCCESS_MESSAGE = "Successfully fetched exact MCP message history!";
export const MCP_EVENT_SUCCESS_MESSAGE = "Successfully fetched exact MCP event evidence!";

export function mcpSuccessResponseBytes(message: string, data: unknown): number {
    const response = { status: 200, message, data };
    return Math.max(
        Buffer.byteLength(JSON.stringify(response), "utf8"),
        Buffer.byteLength(JSON.stringify(response, null, 2), "utf8")
    );
}
