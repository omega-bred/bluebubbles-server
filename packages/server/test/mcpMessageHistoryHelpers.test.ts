import {
    mcpMessageHistorySelection,
    validateMcpMessageHistoryRequest
} from "../src/server/api/interfaces/mcpMessageHistoryHelpers";

describe("MCP message history helpers", () => {
    it("accepts a bounded exact-chat keyset page", () => {
        const request = validateMcpMessageHistoryRequest({
            limit: 101,
            anchorApple: "800000000123456789",
            lastDateApple: "799999999000000000",
            lastRow: 42,
            afterApple: "700000000000000000",
            beforeApple: "810000000000000000",
            chatGuid: "iMessage;-;+14155550123"
        });
        const selection = mcpMessageHistorySelection(request);
        expect(selection.sql).toContain("ORDER BY (CASE WHEN ABS(m.date)<10000000000");
        expect(selection.sql).toContain("m.ROWID<?");
        expect(selection.sql).toContain("c.guid=?");
        expect(selection.parameters).toEqual([
            BigInt("800000000123456789"),
            BigInt("700000000000000000"),
            BigInt("810000000000000000"),
            BigInt("799999999000000000"),
            BigInt("799999999000000000"),
            BigInt(42),
            "iMessage;-;+14155550123",
            101
        ]);
    });

    it("uses case-insensitive exact email handles", () => {
        const selection = mcpMessageHistorySelection(
            validateMcpMessageHistoryRequest({
                limit: 2,
                anchorApple: "8",
                contactAddress: "Person@Example.com"
            })
        );
        expect(selection.sql).toContain("h.id=? COLLATE NOCASE");
        expect(selection.parameters).toContain("Person@Example.com");
    });

    it.each([
        {},
        { limit: 0, anchorApple: "1" },
        { limit: "1", anchorApple: "1" },
        { limit: 1, anchorApple: "01" },
        { limit: 1, anchorApple: "1", lastDateApple: "1" },
        { limit: 1, anchorApple: "1", lastDateApple: "1", lastRow: "1" },
        { limit: 1, anchorApple: "1", afterApple: "2", beforeApple: "2" },
        { limit: 1, anchorApple: "1", chatGuid: "g", contactAddress: "+14155550123" },
        { limit: 1, anchorApple: "1", contactAddress: "555-0123" },
        { limit: 1, anchorApple: "1", unexpected: true }
    ])("rejects malformed or scope-ambiguous input %#", request => {
        expect(() => validateMcpMessageHistoryRequest(request)).toThrow();
    });
});
