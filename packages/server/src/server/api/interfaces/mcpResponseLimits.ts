export const MCP_CHAT_SUCCESS_MESSAGE = "Successfully fetched exact MCP chat catalog!";
export const MCP_HISTORY_SUCCESS_MESSAGE = "Successfully fetched exact MCP message history!";
export const MCP_EVENT_SUCCESS_MESSAGE = "Successfully fetched exact MCP event evidence!";
export const MCP_CONTACT_SUCCESS_MESSAGE = "Successfully matched MCP contacts!";
export const MCP_ACTIVITY_SUCCESS_MESSAGE = "Successfully fetched exact MCP contact activity!";
export const MCP_ATTACHMENT_SUCCESS_MESSAGE = "Successfully fetched exact MCP attachment metadata!";
export const MCP_TRANSCRIPTION_SUCCESS_MESSAGE = "Successfully processed bounded local MCP transcription!";

export function mcpSuccessResponseBytes(message: string, data: unknown): number {
    const response = { status: 200, message, data };
    return Math.max(
        Buffer.byteLength(JSON.stringify(response), "utf8"),
        Buffer.byteLength(JSON.stringify(response, null, 2), "utf8")
    );
}
