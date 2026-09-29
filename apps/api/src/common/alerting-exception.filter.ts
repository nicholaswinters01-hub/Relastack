import { Catch, HttpException, HttpStatus, Logger, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { OpsAlertsService, describeError } from '../notifications/ops-alerts.service';

interface ErrorRequest {
  id: string;
  method: string;
  routeOptions?: { url?: string };
}

interface ErrorReply {
  sent: boolean;
  status(code: number): { send(body: unknown): unknown };
}

/** An error that answers for itself: a refusal, a validation failure, a provider being down. */
function isExpected(exception: unknown): boolean {
  if (exception instanceof HttpException) {
    return exception.getStatus() !== HttpStatus.INTERNAL_SERVER_ERROR;
  }
  // Fastify's own errors (a body too large, a malformed one) carry a status.
  const status = (exception as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status < 500;
}

/**
 * The last stop for an error in a request.
 *
 * Expected errors go on to Nest's usual handling unchanged. An unexpected one
 * is logged with the request's reference, reported to the people who run
 * RelaStack, and answered with that reference so whoever hit it can quote it
 * to the help desk. The answer says nothing about what went wrong: an error's
 * message can carry anything, including another business's data.
 */
@Catch()
export class AlertingExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('Unexpected');

  constructor(private readonly alerts: OpsAlertsService) {
    super();
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (isExpected(exception)) {
      super.catch(exception, host);
      return;
    }

    const http = host.switchToHttp();
    const request = http.getRequest<ErrorRequest>();
    const reply = http.getResponse<ErrorReply>();
    const reference = String(request.id);
    const route = request.routeOptions?.url ?? 'unknown route';

    this.logger.error(
      `ref ${reference} ${request.method} ${route}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    this.alerts.report({
      where: `${request.method} ${route}`,
      what: describeError(exception),
      reference,
    });

    if (reply.sent) return;
    void reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong on our side. If it keeps happening, quote this reference.',
      reference,
    });
  }
}
