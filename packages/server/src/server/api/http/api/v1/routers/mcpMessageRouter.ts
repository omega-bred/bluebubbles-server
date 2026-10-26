import type { Next } from "koa";
import type { RouterContext } from "koa-router";

import { McpChatCatalog } from "@server/api/interfaces/mcpChatCatalog";
import { McpEventEvidence } from "@server/api/interfaces/mcpEventEvidence";
import { McpValidationError } from "@server/api/interfaces/mcpErrors";
import { McpMessageHistory } from "@server/api/interfaces/mcpMessageHistory";
import { McpContactMatch } from "@server/api/interfaces/mcpContactMatch";
import { McpContactActivity } from "@server/api/interfaces/mcpContactActivity";
import { McpAttachmentMetadata } from "@server/api/interfaces/mcpAttachmentMetadata";
import { McpAttachmentTranscription } from "@server/api/interfaces/mcpAttachmentTranscription";
import {
    MCP_ACTIVITY_SUCCESS_MESSAGE,
    MCP_ATTACHMENT_SUCCESS_MESSAGE,
    MCP_CHAT_SUCCESS_MESSAGE,
    MCP_CONTACT_SUCCESS_MESSAGE,
    MCP_EVENT_SUCCESS_MESSAGE,
    MCP_HISTORY_SUCCESS_MESSAGE,
    MCP_TRANSCRIPTION_SUCCESS_MESSAGE
} from "@server/api/interfaces/mcpResponseLimits";
import { BadRequest, ServerError } from "../responses/errors";
import { Success } from "../responses/success";

function safeFailure(error: unknown, operation: string): never {
    if (error instanceof McpValidationError) throw new BadRequest({ error: error.message });
    throw new ServerError({ error: `${operation} is temporarily unavailable` });
}

export class McpMessageRouter {
    static async attachmentTranscription(ctx: RouterContext, _: Next) {
        try {
            return new Success(ctx, {
                message: MCP_TRANSCRIPTION_SUCCESS_MESSAGE,
                data: await McpAttachmentTranscription.read(ctx?.request?.body ?? {})
            }).send();
        } catch (error: unknown) {
            safeFailure(error, "MCP attachment transcription");
        }
    }

    static async attachmentMetadata(ctx: RouterContext, _: Next) {
        try {
            return new Success(ctx, {
                message: MCP_ATTACHMENT_SUCCESS_MESSAGE,
                data: McpAttachmentMetadata.read(ctx?.request?.body ?? {})
            }).send();
        } catch (error: unknown) {
            safeFailure(error, "MCP attachment metadata");
        }
    }

    static async contactActivity(ctx: RouterContext, _: Next) {
        try {
            return new Success(ctx, {
                message: MCP_ACTIVITY_SUCCESS_MESSAGE,
                data: await McpContactActivity.read(ctx?.request?.body ?? {})
            }).send();
        } catch (error: unknown) {
            safeFailure(error, "MCP contact activity");
        }
    }

    static async contactMatch(ctx: RouterContext, _: Next) {
        try {
            return new Success(ctx, {
                message: MCP_CONTACT_SUCCESS_MESSAGE,
                data: await McpContactMatch.read(ctx?.request?.body ?? {})
            }).send();
        } catch (error: unknown) {
            safeFailure(error, "MCP contact match");
        }
    }

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
