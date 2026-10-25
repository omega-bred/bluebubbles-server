import type { Context, Next } from "koa";

import type { HttpRoute, HttpRouteGroup, KoaMiddleware } from "../../types";
import { AuthMiddleware } from "./middleware/authMiddleware";
import { ErrorMiddleware } from "./middleware/errorMiddleware";
import { LogMiddleware } from "./middleware/logMiddleware";
import { MetricsMiddleware } from "./middleware/metricsMiddleware";

export function unprotectedMiddleware(): KoaMiddleware[] {
    return [MetricsMiddleware, ErrorMiddleware, LogMiddleware];
}

export function protectedMiddleware(): KoaMiddleware[] {
    return [...unprotectedMiddleware(), AuthMiddleware];
}

function timeoutMiddleware(requestTimeoutMs: number, responseTimeoutMs: number): KoaMiddleware {
    return async (ctx: Context, next: Next) => {
        ctx.req.setTimeout(requestTimeoutMs, () => {
            ctx.status = 504;
            ctx.set("Content-Type", "application/json");
            ctx.res.end(
                JSON.stringify({
                    status: 504,
                    message: `The request timed-out after ${requestTimeoutMs} ms!`,
                    error: {
                        type: "Gateway Timeout",
                        message: "The data in your request took too long to get to the server!"
                    }
                })
            );
        });

        ctx.res.setTimeout(responseTimeoutMs, () => {
            ctx.status = 504;
            ctx.set("Content-Type", "application/json");
            ctx.res.end(
                JSON.stringify({
                    status: 504,
                    message: `The request timed-out after ${responseTimeoutMs}!`,
                    error: {
                        type: "Gateway Timeout",
                        message: "The server took too long to respond and has timed-out!"
                    }
                })
            );
        });

        await next();
    };
}

export function buildHttpMiddleware(
    group: HttpRouteGroup,
    route: HttpRoute,
    defaultRequestTimeout: number,
    defaultResponseTimeout: number
): KoaMiddleware[] {
    const requestTimeout =
        route.requestTimeoutMs && route.requestTimeoutMs > 0
            ? route.requestTimeoutMs
            : group.requestTimeoutMs && group.requestTimeoutMs > 0
            ? group.requestTimeoutMs
            : defaultRequestTimeout;
    const responseTimeout =
        route.responseTimeoutMs && route.responseTimeoutMs > 0
            ? route.responseTimeoutMs
            : group.responseTimeoutMs && group.responseTimeoutMs > 0
            ? group.responseTimeoutMs
            : defaultResponseTimeout;
    return [
        ...(route.middleware ?? group.middleware ?? []),
        timeoutMiddleware(requestTimeout, responseTimeout),
        ...(route.validators ?? []),
        route.controller
    ];
}
