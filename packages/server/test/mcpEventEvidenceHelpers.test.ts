import {
    pythonCompatibleSourceIdentityParts,
    validateMcpEventEvidenceRequest
} from "../src/server/api/interfaces/mcpEventEvidenceHelpers";

describe("MCP event evidence helpers", () => {
    it("reproduces Python birth-v1 identity material for a synthetic database", () => {
        expect(
            pythonCompatibleSourceIdentityParts(
                "/synthetic/Library/Messages/chat.db",
                BigInt("424242"),
                BigInt("1700000000123456789")
            )
        ).toBe("birth-v1:7a584324b9ef28ba242339df99f521a128ce1e2ddd8d7bd1a89d46c690c0f272");
    });

    it("accepts bounded read-only requests", () => {
        expect(validateMcpEventEvidenceRequest({ after: 40, pending: [2, 3], limit: 250 })).toEqual({
            after: 40,
            pending: [2, 3],
            limit: 250
        });
    });

    it.each([
        { after: -1, pending: [], limit: 1 },
        { after: "0", pending: [], limit: 1 },
        { after: 0, pending: [1, 1], limit: 1 },
        { after: 0, pending: [], limit: 251 },
        { after: 0, pending: [], limit: 1, unexpected: true }
    ])("rejects unsafe or unsupported input %#", request => {
        expect(() => validateMcpEventEvidenceRequest(request)).toThrow();
    });
});
