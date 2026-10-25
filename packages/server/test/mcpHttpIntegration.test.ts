import * as http from "http";
import KoaApp from "koa";
import koaBody from "koa-body";
import KoaRouter from "koa-router";

const mockLogs: string[] = [];
const mockServer = {
    lastConnection: 0,
    repo: {
        getConfig: (name: string) => (name === "password" ? "synthetic-test-credential" : null)
    },
    log: (message: string) => mockLogs.push(message)
};

import { setMcpTestServer } from "./support/mcpServerMock";
import { McpChatCatalog } from "../src/server/api/interfaces/mcpChatCatalog";
import { McpEventEvidence } from "../src/server/api/interfaces/mcpEventEvidence";
import { McpMessageHistory } from "../src/server/api/interfaces/mcpMessageHistory";
import { MCP_MESSAGE_ROUTES } from "../src/server/api/http/api/v1/mcpMessageRoutes";
import { buildHttpMiddleware, protectedMiddleware } from "../src/server/api/http/api/v1/routeMiddleware";
import { AuthMiddleware } from "../src/server/api/http/api/v1/middleware/authMiddleware";
import { ErrorMiddleware } from "../src/server/api/http/api/v1/middleware/errorMiddleware";
import { LogMiddleware } from "../src/server/api/http/api/v1/middleware/logMiddleware";
import { MetricsMiddleware } from "../src/server/api/http/api/v1/middleware/metricsMiddleware";
import type { HttpRouteGroup } from "../src/server/api/http/types";

type HttpResult = { status: number; body: any };

const group: HttpRouteGroup = {
    name: "Message",
    prefix: "message",
    middleware: protectedMiddleware(),
    routes: MCP_MESSAGE_ROUTES
};

async function withServer(run: (port: number) => Promise<void>): Promise<void> {
    const app = new KoaApp();
    app.use(koaBody({ jsonLimit: "64kb", parsedMethods: ["POST"] }));
    const router = new KoaRouter();
    for (const route of MCP_MESSAGE_ROUTES) {
        router.post(`/api/v1/message/${route.path}`, ...buildHttpMiddleware(group, route, 5_000, 5_000));
    }
    app.use(router.routes()).use(router.allowedMethods());
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    try {
        const address = server.address();
        if (address == null || typeof address === "string") throw new Error("Missing test server address");
        await run(address.port);
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close(error => (error == null ? resolve() : reject(error)))
        );
    }
}

function post(port: number, path: string, body: unknown, credential?: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
        const suffix = credential == null ? "" : `?password=${encodeURIComponent(credential)}`;
        const payload = Buffer.from(JSON.stringify(body), "utf8");
        const request = http.request(
            {
                host: "127.0.0.1",
                port,
                method: "POST",
                path: `/api/v1/message/${path}${suffix}`,
                headers: { "Content-Type": "application/json", "Content-Length": payload.length }
            },
            response => {
                const chunks: Buffer[] = [];
                response.on("data", chunk => chunks.push(Buffer.from(chunk)));
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve({ status: response.statusCode ?? 0, body: text.length === 0 ? null : JSON.parse(text) });
                });
            }
        );
        request.once("error", reject);
        request.end(payload);
    });
}

const endpoints = [
    {
        path: "mcp/chats",
        body: { groupsOnly: true, limit: 10 },
        spy: () => jest.spyOn(McpChatCatalog, "read").mockReturnValue({ rows: [], nextCursor: null })
    },
    {
        path: "mcp/history",
        body: { limit: 1, anchorApple: "1" },
        spy: () => jest.spyOn(McpMessageHistory, "read").mockResolvedValue({ rows: [] })
    },
    {
        path: "mcp/event-evidence",
        body: { after: 0, pending: [], limit: 0 },
        spy: () =>
            jest.spyOn(McpEventEvidence, "read").mockReturnValue({
                sourceIdentity: `birth-v1:${"0".repeat(64)}`,
                maximumRow: 0,
                maximumChatRow: 0,
                rows: []
            })
    }
];

describe("MCP HTTP authentication and middleware", () => {
    beforeEach(() => {
        mockLogs.splice(0);
        setMcpTestServer(mockServer);
    });
    afterEach(() => jest.restoreAllMocks());

    it("uses the inherited protected middleware in production order without route overrides", () => {
        for (const route of MCP_MESSAGE_ROUTES) {
            expect(route.middleware).toBeUndefined();
            const middleware = buildHttpMiddleware(group, route, 5_000, 5_000);
            expect(middleware.slice(0, 4)).toEqual([MetricsMiddleware, ErrorMiddleware, LogMiddleware, AuthMiddleware]);
            expect(middleware[middleware.length - 1]).toBe(route.controller);
        }
    });

    it.each(endpoints)("rejects missing and wrong credentials for $path", async endpoint => {
        const handler = endpoint.spy();
        await withServer(async port => {
            expect((await post(port, endpoint.path, endpoint.body)).status).toBe(401);
            expect((await post(port, endpoint.path, endpoint.body, "wrong-synthetic-credential")).status).toBe(401);
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it.each(endpoints)("lets a valid credential reach the intended $path handler", async endpoint => {
        const handler = endpoint.spy();
        await withServer(async port => {
            const result = await post(port, endpoint.path, endpoint.body, "synthetic-test-credential");
            expect(result.status).toBe(200);
            expect(result.body.status).toBe(200);
        });
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it.each(endpoints)("returns a generic 500 and redacts internal $path failures", async endpoint => {
        const sentinel = "PRIVATE-SENTINEL /private/data/chat.db SELECT secret message-body";
        endpoint.spy().mockImplementation(() => {
            throw new Error(sentinel);
        });
        await withServer(async port => {
            const result = await post(port, endpoint.path, endpoint.body, "synthetic-test-credential");
            expect(result.status).toBe(500);
            expect(JSON.stringify(result.body)).not.toContain(sentinel);
            expect(JSON.stringify(result.body)).toContain("temporarily unavailable");
        });
        expect(mockLogs.join("\n")).not.toContain(sentinel);
    });

    it.each([
        { path: "mcp/chats", body: { groupsOnly: "yes" } },
        { path: "mcp/history", body: {} },
        { path: "mcp/event-evidence", body: { after: -1, pending: [], limit: 1 } }
    ])("keeps safe validation failures as 400 for $path", async endpoint => {
        await withServer(async port => {
            const result = await post(port, endpoint.path, endpoint.body, "synthetic-test-credential");
            expect(result.status).toBe(400);
            expect(result.body.error.type).toBe("Validation Error");
        });
    });
});
