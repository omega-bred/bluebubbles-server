import {
    contactSimilarity,
    McpMatchingBudget,
    messageSimilarity,
    sequenceMatcherRatio,
    weightedRatio
} from "../src/server/api/interfaces/mcpMatchingHelpers";

describe("MCP reusable matching semantics", () => {
    it.each([
        ["meeting tomorrow", "Meeting tomorrow at noon", 0.9],
        ["recieve", "receive", 0.86],
        ["alpha beta", "beta alpha", 0.95],
        ["hello, world!", "hello world", 0.96],
        ["Jose", "José", 0.86],
        ["🚀 launch plan", "launch plan", 1],
        ["new york mets", "new york mets vs atlanta braves", 0.9],
        ["YANKEES", "NEW YORK YANKEES", 0.9],
        ["abcd", "badc", 0.5],
        ["abcdeXYZ", "abcdeUVW", 0.62]
    ])("matches the pinned Python TheFuzz 0.22.1 WRatio oracle for %p", (left, right, expected) => {
        expect(weightedRatio(left as string, right as string)).toBe(expected);
    });

    it("keeps the exact-substring first pass from the Python connector", () => {
        expect(messageSimilarity("meeting tomorrow", "Meeting tomorrow at noon")).toBe(1);
    });

    it("preserves contact token and prefix behavior", () => {
        expect(contactSimilarity("alex", "Alex Morgan")).toBeGreaterThanOrEqual(0.8);
        expect(contactSimilarity("morgan", "Alex Morgan")).toBe(0.95);
        expect(contactSimilarity("unrelated", "Alex Morgan")).toBeLessThan(0.6);
    });

    it("uses Python's full-name fallback when no token reaches the threshold", () => {
        expect(contactSimilarity("alexanderjones", "Alexander Jones", new McpMatchingBudget(), 0.6)).toBeGreaterThan(
            0.9
        );
    });

    it("handles Unicode by code point", () => {
        expect(sequenceMatcherRatio("José", "Jose")).toBeGreaterThan(0.7);
    });

    it("fails explicitly before exceeding its cell-work budget", () => {
        expect(() => weightedRatio("abcdefgh", "abcdefgh", new McpMatchingBudget(10))).toThrow(
            "bounded computation budget"
        );
    });
});
