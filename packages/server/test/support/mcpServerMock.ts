let current: any = null;

export function setMcpTestServer(server: any): void {
    current = server;
}

export function Server(): any {
    if (current == null) throw new Error("Synthetic MCP test server is not configured");
    return current;
}
