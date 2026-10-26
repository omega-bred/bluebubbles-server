import { McpContactMatch } from "../src/server/api/interfaces/mcpContactMatch";
import { setMcpTestContacts } from "./support/mcpContactInterfaceMock";

describe("MCP contact matching", () => {
    it("returns deduplicated address matches with backend-owned scores", async () => {
        setMcpTestContacts([
            {
                displayName: "Alex Morgan",
                nickname: "Lex",
                phoneNumbers: [{ address: "+14155550123" }],
                emails: [{ address: "Alex@example.com" }]
            },
            {
                displayName: "Alex Morgan",
                phoneNumbers: [{ address: "+14155550123" }],
                emails: []
            },
            {
                displayName: "Other Person",
                phoneNumbers: [{ address: "+14155550999" }],
                emails: []
            }
        ]);

        const response = await McpContactMatch.read({ query: "alex", limit: 10, threshold: 0.6 });
        expect(response.rows.map(row => row.address)).toEqual(["+14155550123", "Alex@example.com"]);
        expect(response.rows.every(row => row.displayName === "Alex Morgan" && row.score >= 0.6)).toBe(true);
        expect(response).toMatchObject({ totalMatches: 2, truncated: false });
    });

    it("reports an explicit bound instead of silently dropping a large ambiguous result", async () => {
        setMcpTestContacts(
            Array.from({ length: 101 }, (_, index) => ({
                displayName: `Alex Person ${index}`,
                phoneNumbers: [{ address: `+1415555${String(index).padStart(4, "0")}` }],
                emails: []
            }))
        );
        const response = await McpContactMatch.read({ query: "alex", limit: 100, threshold: 0.6 });
        expect(response.rows).toHaveLength(100);
        expect(response).toMatchObject({ totalMatches: 101, truncated: true });
        expect(new Set(response.rows.map(row => row.address)).size).toBe(100);
    });

    it.each([
        {},
        { query: "" },
        { query: "a", limit: 0 },
        { query: "a", threshold: -1 },
        { query: "a", unexpected: true }
    ])("rejects malformed input %#", async request => {
        await expect(McpContactMatch.read(request)).rejects.toThrow();
    });
});
