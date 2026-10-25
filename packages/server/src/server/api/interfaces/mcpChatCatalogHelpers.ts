import { invalidMcpRequest } from "./mcpErrors";

export type McpChatCatalogCursor = {
    rank: number;
    name: string;
    row: number;
};

export type McpChatCatalogRequest = {
    groupsOnly: boolean;
    identifier: string | null;
    limit: number;
    cursor: McpChatCatalogCursor | null;
};

export const MCP_CHAT_CURSOR_MAX_LENGTH = 64 * 1024;
export const MCP_CHAT_CURSOR_NAME_MAX_CHARS = 8192;

function encodeCursor(cursor: McpChatCatalogCursor): string {
    return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8")
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

function decodeCursor(value: unknown): McpChatCatalogCursor | null {
    if (value == null) return null;
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MCP_CHAT_CURSOR_MAX_LENGTH ||
        !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
        invalidMcpRequest("cursor must be a bounded opaque string");
    }
    try {
        const base64 = value
            .replace(/-/g, "+")
            .replace(/_/g, "/")
            .padEnd(Math.ceil(value.length / 4) * 4, "=");
        const parsed = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as Record<string, unknown>;
        if (
            parsed == null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.keys(parsed).some(key => !["v", "rank", "name", "row"].includes(key)) ||
            parsed.v !== 1 ||
            (parsed.rank !== 0 && parsed.rank !== 1) ||
            typeof parsed.name !== "string" ||
            parsed.name.length > MCP_CHAT_CURSOR_NAME_MAX_CHARS ||
            !Number.isSafeInteger(parsed.row) ||
            Number(parsed.row) < 0 ||
            encodeCursor({ rank: Number(parsed.rank), name: parsed.name, row: Number(parsed.row) }) !== value
        ) {
            invalidMcpRequest("cursor is invalid");
        }
        return { rank: Number(parsed.rank), name: parsed.name, row: Number(parsed.row) };
    } catch (error) {
        if (error instanceof Error && error.name === "McpValidationError") throw error;
        invalidMcpRequest("cursor is invalid");
    }
}

export function encodeMcpChatCatalogCursor(cursor: McpChatCatalogCursor): string {
    if (cursor.name.length > MCP_CHAT_CURSOR_NAME_MAX_CHARS) {
        throw new Error("One MCP chat sort name exceeds the cursor character limit");
    }
    const encoded = encodeCursor(cursor);
    if (encoded.length > MCP_CHAT_CURSOR_MAX_LENGTH) {
        throw new Error("One MCP chat cursor exceeds the cursor byte limit");
    }
    return encoded;
}

export function validateMcpChatCatalogRequest(body: unknown): McpChatCatalogRequest {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
        invalidMcpRequest("Expected an MCP chat-catalog request object");
    }
    const request = body as Record<string, unknown>;
    if (Object.keys(request).some(key => !["groupsOnly", "identifier", "limit", "cursor"].includes(key))) {
        invalidMcpRequest("Unsupported MCP chat-catalog request field");
    }
    const groupsOnly = request.groupsOnly ?? false;
    if (typeof groupsOnly !== "boolean") invalidMcpRequest("groupsOnly must be a boolean");
    const identifier = request.identifier ?? null;
    if (
        identifier != null &&
        (typeof identifier !== "string" ||
            identifier.length === 0 ||
            identifier.length > 2048 ||
            identifier !== identifier.trim())
    ) {
        invalidMcpRequest("identifier must be a bounded exact string without surrounding whitespace");
    }
    const limit = request.limit ?? 100;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        invalidMcpRequest("limit must be an integer from 1 through 100");
    }
    return {
        groupsOnly,
        identifier: identifier as string | null,
        limit,
        cursor: decodeCursor(request.cursor)
    };
}

export function mcpChatCatalogSelection(request: McpChatCatalogRequest): {
    sql: string;
    parameters: unknown[];
} {
    const rank = "CASE WHEN display_name IS NULL OR trim(display_name)='' THEN 1 ELSE 0 END";
    const name = "CASE WHEN display_name IS NULL OR trim(display_name)='' THEN '' ELSE display_name END";
    const clauses = ["guid IS NOT NULL"];
    const parameters: unknown[] = [];
    if (request.groupsOnly) clauses.push("style=43");
    if (request.identifier != null) {
        clauses.push("(guid=? OR chat_identifier=? OR room_name=?)");
        parameters.push(request.identifier, request.identifier, request.identifier);
    }
    if (request.cursor != null) {
        clauses.push(
            `(${rank}>? OR (${rank}=? AND (${name} COLLATE NOCASE>? COLLATE NOCASE OR (${name} COLLATE NOCASE=? COLLATE NOCASE AND ROWID<?))))`
        );
        parameters.push(
            request.cursor.rank,
            request.cursor.rank,
            request.cursor.name,
            request.cursor.name,
            request.cursor.row
        );
    }
    parameters.push(request.limit + 1);
    return {
        sql: `SELECT ROWID AS row_id,guid,chat_identifier,display_name,room_name,style,${rank} AS sort_rank,${name} AS sort_name FROM chat WHERE ${clauses.join(
            " AND "
        )} ORDER BY ${rank},${name} COLLATE NOCASE,ROWID DESC LIMIT ?`,
        parameters
    };
}
