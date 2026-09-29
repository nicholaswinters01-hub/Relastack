import {
  ArgumentsHost,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpsAlertsService } from '../notifications/ops-alerts.service';
import { AlertingExceptionFilter } from './alerting-exception.filter';

function setUp() {
  const report = vi.fn();
  const filter = new AlertingExceptionFilter({ report } as unknown as OpsAlertsService);
  const send = vi.fn();
  const reply = { sent: false, status: vi.fn(() => ({ send })) };
  const request = {
    id: 'ab12cd34',
    method: 'GET',
    routeOptions: { url: '/api/v1/customers/:id' },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  const passedOn = vi.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => {});
  return { filter, report, reply, send, host, passedOn };
}

describe('AlertingExceptionFilter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leaves a refusal to the usual handling, and reports nothing', () => {
    const { filter, report, passedOn, host } = setUp();
    filter.catch(new ForbiddenException(), host);
    expect(passedOn).toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('leaves a Fastify client error alone', () => {
    const { filter, report, passedOn, host } = setUp();
    filter.catch(Object.assign(new Error('Body is too large'), { statusCode: 413 }), host);
    expect(passedOn).toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a crash and answers with its reference, not its message', () => {
    const { filter, report, reply, send, host, passedOn } = setUp();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    filter.catch(new TypeError('cannot read jane@example.test'), host);

    expect(passedOn).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({
      where: 'GET /api/v1/customers/:id',
      what: 'TypeError',
      reference: 'ab12cd34',
    });
    expect(reply.status).toHaveBeenCalledWith(500);
    const body = send.mock.calls[0]![0];
    expect(body).toMatchObject({ statusCode: 500, reference: 'ab12cd34' });
    expect(JSON.stringify(body)).not.toContain('jane@example.test');
  });

  it('treats an explicit 500 as a crash too', () => {
    const { filter, report, host } = setUp();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    filter.catch(new InternalServerErrorException('boom'), host);
    expect(report).toHaveBeenCalled();
  });
});
