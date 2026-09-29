import type { ServerEnv } from '@platform/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailMessage, EmailService } from './email.service';
import { ALERT_WINDOW_MS, OpsAlertsService, describeError } from './ops-alerts.service';

function makeService(send = vi.fn(async (_message: EmailMessage) => undefined)) {
  const service = new OpsAlertsService(
    { send } as unknown as EmailService,
    { SUPPORT_NOTIFY_EMAIL: 'ops@example.test' } as ServerEnv,
  );
  return { service, send };
}

describe('OpsAlertsService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the first incident at once, to the support address', async () => {
    const { service, send } = makeService();
    service.report({
      where: 'GET /api/v1/customers/:id',
      what: 'TypeError',
      reference: 'ab12cd34',
    });
    await vi.runAllTicks();
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]![0];
    expect(message.to).toBe('ops@example.test');
    expect(message.subject).toContain('1 error');
    expect(message.body).toContain('GET /api/v1/customers/:id  TypeError  ref ab12cd34');
  });

  it('holds the rest of the window back and sends them together', async () => {
    const { service, send } = makeService();
    service.report({ where: 'a', what: 'TypeError' });
    await vi.runAllTicks();
    service.report({ where: 'b', what: 'TypeError' });
    service.report({ where: 'c', what: 'RangeError' });
    await vi.runAllTicks();
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ALERT_WINDOW_MS);
    expect(send).toHaveBeenCalledTimes(2);
    const digest = send.mock.calls[1]![0];
    expect(digest.subject).toContain('2 errors');
    expect(digest.body).toContain('b  TypeError');
    expect(digest.body).toContain('c  RangeError');
  });

  it('lists a flood only up to a point, and counts the rest', async () => {
    const { service, send } = makeService();
    service.report({ where: 'first', what: 'Error' });
    for (let i = 0; i < 50; i += 1) service.report({ where: `r${i}`, what: 'Error' });
    await vi.advanceTimersByTimeAsync(ALERT_WINDOW_MS);
    const digest = send.mock.calls[1]![0];
    expect(digest.subject).toContain('50 errors');
    expect(digest.body).toContain('…and 30 more.');
  });

  it('never throws when the email itself fails', async () => {
    const { service } = makeService(
      vi.fn(async () => {
        throw new Error('mail is down');
      }),
    );
    expect(() => service.report({ where: 'x', what: 'Error' })).not.toThrow();
    await expect(service.flush()).resolves.toBeUndefined();
  });
});

describe('describeError', () => {
  it('names the class and a code, never the message', () => {
    const error = Object.assign(new Error('customer jane@example.test already exists'), {
      code: 'P2002',
    });
    expect(describeError(error)).toBe('Error P2002');
    expect(describeError(new TypeError('secret'))).toBe('TypeError');
    expect(describeError('a string')).toBe('string');
  });
});
