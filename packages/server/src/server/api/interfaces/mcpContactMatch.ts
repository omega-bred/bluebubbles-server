import { ContactInterface } from "@server/api/interfaces/contactInterface";
import { contactSimilarity, McpMatchingBudget } from "@server/api/interfaces/mcpMatchingHelpers";
import { invalidMcpRequest } from "@server/api/interfaces/mcpErrors";
import { MCP_CONTACT_SUCCESS_MESSAGE, mcpSuccessResponseBytes } from "@server/api/interfaces/mcpResponseLimits";

export const MCP_CONTACT_RESPONSE_MAX_BYTES = 128 * 1024;

type ContactMatchRequest = {
    query: string;
    limit: number;
    threshold: number;
};

type ContactMatch = {
    displayName: string;
    address: string;
    score: number;
    matchedOn: string;
};

function validate(body: unknown): ContactMatchRequest {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
        invalidMcpRequest("Expected an MCP contact-match request object");
    }
    const request = body as Record<string, unknown>;
    if (Object.keys(request).some(key => !["query", "limit", "threshold"].includes(key))) {
        invalidMcpRequest("Unsupported MCP contact-match request field");
    }
    const query = request.query;
    if (typeof query !== "string" || query.trim().length === 0 || query.length > 320) {
        invalidMcpRequest("query must be a non-empty string of at most 320 characters");
    }
    const limit = request.limit ?? 10;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        invalidMcpRequest("limit must be an integer from 1 through 100");
    }
    const threshold = request.threshold ?? 0.6;
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        invalidMcpRequest("threshold must be a finite number from 0 through 1");
    }
    return { query, limit, threshold };
}

function strings(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    return values
        .map(value => (typeof value === "string" ? value : (value as any)?.address))
        .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export class McpContactMatch {
    static async read(body: unknown): Promise<{ rows: ContactMatch[]; totalMatches: number; truncated: boolean }> {
        const request = validate(body);
        const contacts = await ContactInterface.getAllContacts();
        const matchingBudget = new McpMatchingBudget();
        const bestByAddress = new Map<string, ContactMatch>();
        for (const contact of contacts) {
            const displayName = String(contact?.displayName ?? "").trim();
            const nickname = String(contact?.nickname ?? "").trim();
            const candidates = [displayName, nickname].filter(Boolean);
            if (candidates.length === 0) continue;
            const scores = candidates.map(candidate => ({
                matchedOn: candidate,
                score: contactSimilarity(request.query, candidate, matchingBudget, request.threshold)
            }));
            scores.sort((left, right) => right.score - left.score || left.matchedOn.localeCompare(right.matchedOn));
            const best = scores[0];
            if (best.score < request.threshold) continue;
            for (const address of [...strings(contact?.phoneNumbers), ...strings(contact?.emails)]) {
                const key = address.includes("@") ? address.toLocaleLowerCase() : address.replace(/[^0-9+]/gu, "");
                if (key.length === 0) continue;
                const current = bestByAddress.get(key);
                const row = { displayName: displayName || best.matchedOn, address, ...best };
                if (current == null || row.score > current.score) bestByAddress.set(key, row);
            }
        }
        const allRows = Array.from(bestByAddress.values()).sort(
            (left, right) =>
                right.score - left.score ||
                left.displayName.localeCompare(right.displayName) ||
                left.address.localeCompare(right.address)
        );
        const response = {
            rows: allRows.slice(0, request.limit),
            totalMatches: allRows.length,
            truncated: allRows.length > request.limit
        };
        if (mcpSuccessResponseBytes(MCP_CONTACT_SUCCESS_MESSAGE, response) > MCP_CONTACT_RESPONSE_MAX_BYTES) {
            throw new Error("MCP contact-match response exceeds the response byte limit");
        }
        return response;
    }
}
