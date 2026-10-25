import type { Next } from "koa";
import type { RouterContext } from "koa-router";

import { McpChatCatalog } from "@server/api/interfaces/mcpChatCatalog";
import { McpEventEvidence } from "@server/api/interfaces/mcpEventEvidence";
import { McpValidationError } from "@server/api/interfaces/mcpErrors";
import { McpMessageHistory } from "@server/api/interfaces/mcpMessageHistory";
import {
    MCP_CHAT_SUCCESS_MESSAGE,
    MCP_EVENT_SUCCESS_MESSAGE,
    MCP_HISTORY_SUCCESS_MESSAGE
} from "@server/api/interfaces/mcpResponseLimits";
import { BadRequest, ServerError } from "../responses/errors";
import { Success } from "../responses/success";

function safeFailure(error: unknown, operation: string): never {
    if (error instanceof McpValidationError) throw new BadRequest({ error: error.message });
    throw new ServerError({ error: `${operation} is temporarily unavailable` });
}

export class McpMessageRouter {
    static async chatCatalog(ctx: RouterContext, _: Next) {
        try {
            return new Success(ctx, {
                message: MCP_CHAT_SUCCESS_MESSAGE,
                data: McpChatCatalog.read(ctx?.request?.body ?? {})
            }).send();
        } catch (error: unknown) {
            safeFailure(error, "MCP chat catalog");
        }
    }

    static async history(ctx: RouterContext, _: Next) {
        try {
            return new Success(ctx, {
                message: MCP_HISTORY_SUCCESS_MESSAGE,
                data: await McpMessageHistory.read(ctx?.request?.body ?? {})
            }).send();
        } catch (error: unknown) {
            safeFailure(error, "MCP message history");
        }
    }

    static async eventEvidence(ctx: RouterContext, _: Next) {
        try {
            return new Success(ctx, {
                message: MCP_EVENT_SUCCESS_MESSAGE,
                data: McpEventEvidence.read(ctx?.request?.body ?? {})
            }).send();
        } catch (error: unknown) {
            safeFailure(error, "MCP event evidence");
        }
    }
}
