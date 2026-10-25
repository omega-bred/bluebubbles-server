import {
    mcpChatCatalogSelection,
    validateMcpChatCatalogRequest
} from "../src/server/api/interfaces/mcpChatCatalogHelpers";

describe("MCP chat catalog helpers", () => {
    it("selects every exact group without a participant join", () => {
        const selection = mcpChatCatalogSelection(validateMcpChatCatalogRequest({ groupsOnly: true }));
        expect(selection.sql).toContain("style=43");
        expect(selection.sql).not.toContain("JOIN");
        expect(selection.sql).toContain("display_name COLLATE NOCASE");
        expect(selection.parameters).toEqual([]);
    });

    it("uses exact identifiers and rejects ambiguous request shapes", () => {
        const selection = mcpChatCatalogSelection(
            validateMcpChatCatalogRequest({ identifier: "iMessage;-;+14155550123" })
        );
        expect(selection.sql).toContain("guid=? OR chat_identifier=? OR room_name=?");
        expect(selection.parameters).toEqual([
            "iMessage;-;+14155550123",
            "iMessage;-;+14155550123",
            "iMessage;-;+14155550123"
        ]);
        expect(() => validateMcpChatCatalogRequest({ groupsOnly: "yes" })).toThrow();
        expect(() => validateMcpChatCatalogRequest({ identifier: " value " })).toThrow();
        expect(() => validateMcpChatCatalogRequest({ unexpected: true })).toThrow();
    });
});
