import {
    type ArgumentsHost,
    Catch,
    type ExceptionFilter,
    Inject,
} from "@nestjs/common";
import type { Logger } from "../observability/logger";
import { mapError } from "./error-mapping";
import type { HttpResponse } from "./http";
import { Metrics } from "./metrics";
import { LOGGER } from "./tokens";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
    constructor(
        @Inject(Metrics) private readonly metrics: Metrics,
        @Inject(LOGGER) private readonly logger: Logger,
    ) {}

    catch(exception: unknown, host: ArgumentsHost): void {
        const http = host.switchToHttp();
        const response = http.getResponse<HttpResponse>();
        const correlationId = http.getRequest<{
            headers?: Record<string, string | undefined>;
        }>().headers?.["x-correlation-id"];
        const mapped = mapError(exception);

        this.metrics.inc("http_errors_total", {
            status: String(mapped.status),
            code: mapped.code,
        });
        if (mapped.status >= 500) {
            this.logger.log("error", "request_failed", {
                correlationId,
                status: mapped.status,
                code: mapped.code,
                error:
                    exception instanceof Error
                        ? exception.message
                        : String(exception),
                stack: exception instanceof Error ? exception.stack : undefined,
            });
        }
        if (mapped.retryAfterSeconds !== undefined) {
            response.setHeader("Retry-After", String(mapped.retryAfterSeconds));
        }
        response.status(mapped.status);
        response.json({
            error: {
                code: mapped.code,
                message: mapped.message,
                retriable: mapped.retriable,
                ...(mapped.details === undefined
                    ? {}
                    : { details: mapped.details }),
            },
        });
    }
}
