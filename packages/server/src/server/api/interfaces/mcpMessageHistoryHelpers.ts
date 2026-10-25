export type McpMessageHistoryRequest = {
    limit: number;
    anchorApple: bigint;
    lastDateApple: bigint | null;
    lastRow: number | null;
    afterApple: bigint | null;
    beforeApple: bigint | null;
    chatGuid: string | null;
    contactAddress: string | null;
};

const INTEGER64_MAX = BigInt("9223372036854775807");

function optionalString(request: Record<string, unknown>, name: string, maximum: number): string | null {
    const value = request[name];
    if (value == null) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim()) {
        throw new Error(`${name} must be a non-empty bounded string without surrounding whitespace`);
    }
    return value;
}

function appleInteger(request: Record<string, unknown>, name: string, required = false): bigint | null {
    const value = request[name];
    if (value == null) {
        if (required) throw new Error(`${name} is required`);
        return null;
    }
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`${name} must be a canonical non-negative 64-bit integer string`);
    }
    const parsed = BigInt(value);
    if (parsed > INTEGER64_MAX) throw new Error(`${name} is outside the signed 64-bit range`);
    return parsed;
}

export function validateMcpMessageHistoryRequest(body: unknown): McpMessageHistoryRequest {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Expected an MCP history request object");
    }
    const request = body as Record<string, unknown>;
    const supported = new Set([
        "limit",
        "anchorApple",
        "lastDateApple",
        "lastRow",
        "afterApple",
        "beforeApple",
        "chatGuid",
        "contactAddress"
    ]);
    if (Object.keys(request).some(key => !supported.has(key))) {
        throw new Error("Unsupported MCP history request field");
    }
    const limit = Number(request.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
        throw new Error("limit must be an integer from 1 through 101");
    }
    const anchorApple = appleInteger(request, "anchorApple", true) as bigint;
    const lastDateApple = appleInteger(request, "lastDateApple");
    const lastRowValue = request.lastRow;
    const lastRow = lastRowValue == null ? null : Number(lastRowValue);
    if ((lastDateApple == null) !== (lastRow == null)) {
        throw new Error("lastDateApple and lastRow must be supplied together");
    }
    if (lastRow != null && (!Number.isSafeInteger(lastRow) || lastRow < 0)) {
        throw new Error("lastRow must be a non-negative safe integer");
    }
    const afterApple = appleInteger(request, "afterApple");
    const beforeApple = appleInteger(request, "beforeApple");
    if (afterApple != null && beforeApple != null && afterApple >= beforeApple) {
        throw new Error("afterApple must be earlier than beforeApple");
    }
    const chatGuid = optionalString(request, "chatGuid", 2048);
    const contactAddress = optionalString(request, "contactAddress", 320);
    if (chatGuid != null && contactAddress != null) {
        throw new Error("chatGuid and contactAddress are mutually exclusive");
    }
    if (contactAddress != null && !contactAddress.includes("@") && !/^\+[1-9][0-9]{7,14}$/.test(contactAddress)) {
        throw new Error("contactAddress must be canonical E.164 or an email address");
    }
    return {
        limit,
        anchorApple,
        lastDateApple,
        lastRow,
        afterApple,
        beforeApple,
        chatGuid,
        contactAddress
    };
}

export function mcpMessageHistorySelection(request: McpMessageHistoryRequest): {
    sql: string;
    parameters: unknown[];
} {
    const dateNs = "(CASE WHEN ABS(m.date)<10000000000 THEN m.date*1000000000 ELSE m.date END)";
    const clauses = [`${dateNs}<=?`];
    const parameters: unknown[] = [request.anchorApple];
    if (request.afterApple != null) {
        clauses.push(`${dateNs}>=?`);
        parameters.push(request.afterApple);
    }
    if (request.beforeApple != null) {
        clauses.push(`${dateNs}<?`);
        parameters.push(request.beforeApple);
    }
    if (request.lastDateApple != null && request.lastRow != null) {
        clauses.push(`(${dateNs}<? OR (${dateNs}=? AND m.ROWID<?))`);
        parameters.push(request.lastDateApple, request.lastDateApple, BigInt(request.lastRow));
    }
    if (request.chatGuid != null) {
        clauses.push(
            "m.ROWID IN (SELECT j.message_id FROM chat_message_join j JOIN chat c ON c.ROWID=j.chat_id WHERE c.guid=?)"
        );
        parameters.push(request.chatGuid);
    }
    if (request.contactAddress != null) {
        if (request.contactAddress.includes("@")) {
            clauses.push("m.handle_id IN (SELECT h.ROWID FROM handle h WHERE h.id=? COLLATE NOCASE)");
            parameters.push(request.contactAddress);
        } else {
            if (!/^\+[1-9][0-9]{7,14}$/.test(request.contactAddress)) {
                throw new Error("contactAddress must be canonical E.164 or an email address");
            }
            const normalized = request.contactAddress.slice(1);
            clauses.push(
                "m.handle_id IN (SELECT h.ROWID FROM handle h WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(h.id,'+',''),' ',''),'-',''),'(',''),')',''),'.','')=?)"
            );
            parameters.push(normalized);
        }
    }
    parameters.push(request.limit);
    return {
        sql: `SELECT m.ROWID AS row_id,${dateNs} AS date_apple FROM message m WHERE ${clauses.join(
            " AND "
        )} ORDER BY ${dateNs} DESC,m.ROWID DESC LIMIT ?`,
        parameters
    };
}
