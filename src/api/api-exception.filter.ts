import { type ArgumentsHost, Catch, type ExceptionFilter, Inject, Logger } from '@nestjs/common';
import { mapError } from './error-mapping';
import type { HttpResponse } from './http';
import { Metrics } from './metrics';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Api');

  constructor(@Inject(Metrics) private readonly metrics: Metrics) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const mapped = mapError(exception);

    this.metrics.inc('http_errors_total', { status: String(mapped.status), code: mapped.code });
    if (mapped.status >= 500) {
      this.logger.error(
        `${mapped.code}: ${exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)}`,
      );
    }
    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    response.status(mapped.status);
    response.json({
      error: {
        code: mapped.code,
        message: mapped.message,
        retriable: mapped.retriable,
        ...(mapped.details === undefined ? {} : { details: mapped.details }),
      },
    });
  }
}
