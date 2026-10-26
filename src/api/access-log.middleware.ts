import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { Logger, LogLevel } from "../observability/logger";
import { Metrics } from "../observability/metrics";
import { LOGGER } from "./tokens";

interface RequestLike {
    method: string;
    originalUrl?: string;
    url: string;
    baseUrl?: string;
    route?: { path?: string };
    headers: Record<string, string | string[] | undefined>;
}

interface ResponseLike {
    statusCode: number;
    setHeader(name: string, value: string): unknown;
    on(event: "finish", listener: () => void): unknown;
}

const QUIET_PATHS = new Set(["/health/live", "/health/ready", "/metrics"]);

@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
    constructor(
        @Inject(Metrics) private readonly metrics: Metrics,
        @Inject(LOGGER) private readonly logger: Logger,
    ) {}

    use(request: RequestLike, response: ResponseLike, next: () => void): void {
        const startedAt = performance.now();
        const incoming = request.headers["x-correlation-id"];
        const correlationId =
            typeof incoming === "string" && incoming.trim() !== ""
                ? incoming
                : crypto.randomUUID();
        request.headers["x-correlation-id"] = correlationId;
        response.setHeader("X-Correlation-Id", correlationId);

        response.on("finish", () => {
            const seconds = (performance.now() - startedAt) / 1000;
            const routePath = request.route?.path;
            const route =
                routePath === undefined
                    ? "unmatched"
                    : `${request.baseUrl ?? ""}${routePath}`;
            const status = response.statusCode;
            const labels = {
                method: request.method,
                route,
                status: String(status),
            };
            this.metrics.inc("http_requests_total", labels);
            this.metrics.observe(
                "http_request_duration_seconds",
                seconds,
                labels,
            );

            const path =
                (request.originalUrl ?? request.url).split("?")[0] ?? "";
            if (QUIET_PATHS.has(path)) {
                return;
            }
            const level: LogLevel =
                status >= 500 ? "error" : status >= 400 ? "warn" : "info";
            this.logger.log(level, "http_request", {
                correlationId,
                method: request.method,
                path,
                route,
                status,
                durationMs: Math.round(seconds * 1000 * 100) / 100,
            });
        });
        next();
    }
}
