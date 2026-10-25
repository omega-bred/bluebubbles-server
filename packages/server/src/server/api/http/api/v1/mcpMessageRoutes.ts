import type { HttpRoute } from "../../types";
import { HttpMethod } from "../../types";
import { McpMessageRouter } from "./routers/mcpMessageRouter";

export const MCP_MESSAGE_ROUTES: HttpRoute[] = [
    {
        method: HttpMethod.POST,
        path: "mcp/event-evidence",
        controller: McpMessageRouter.eventEvidence
    },
    {
        method: HttpMethod.POST,
        path: "mcp/history",
        controller: McpMessageRouter.history
    },
    {
        method: HttpMethod.POST,
        path: "mcp/chats",
        controller: McpMessageRouter.chatCatalog
    }
];
