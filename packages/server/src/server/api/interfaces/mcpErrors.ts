export class McpValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "McpValidationError";
    }
}

export function invalidMcpRequest(message: string): never {
    throw new McpValidationError(message);
}
