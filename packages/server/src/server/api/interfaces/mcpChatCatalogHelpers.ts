export type McpChatCatalogRequest = {
    groupsOnly: boolean;
    identifier: string | null;
};

export function validateMcpChatCatalogRequest(body: unknown): McpChatCatalogRequest {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Expected an MCP chat-catalog request object");
    }
    const request = body as Record<string, unknown>;
    if (Object.keys(request).some(key => !["groupsOnly", "identifier"].includes(key))) {
        throw new Error("Unsupported MCP chat-catalog request field");
    }
    const groupsOnly = request.groupsOnly ?? false;
    if (typeof groupsOnly !== "boolean") throw new Error("groupsOnly must be a boolean");
    const identifier = request.identifier ?? null;
    if (
        identifier != null &&
        (typeof identifier !== "string" || identifier.length === 0 || identifier.length > 2048 || identifier !== identifier.trim())
    ) {
        throw new Error("identifier must be a bounded exact string without surrounding whitespace");
    }
    return { groupsOnly, identifier: identifier as string | null };
}

export function mcpChatCatalogSelection(request: McpChatCatalogRequest): {
    sql: string;
    parameters: unknown[];
} {
    const clauses = ["guid IS NOT NULL"];
    const parameters: unknown[] = [];
    if (request.groupsOnly) clauses.push("style=43");
    if (request.identifier != null) {
        clauses.push("(guid=? OR chat_identifier=? OR room_name=?)");
        parameters.push(request.identifier, request.identifier, request.identifier);
    }
    return {
        sql: `SELECT ROWID AS row_id,guid,chat_identifier,display_name,room_name,style FROM chat WHERE ${clauses.join(
            " AND "
        )} ORDER BY CASE WHEN display_name IS NULL OR trim(display_name)='' THEN 1 ELSE 0 END,display_name COLLATE NOCASE,ROWID DESC`,
        parameters
    };
}
