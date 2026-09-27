import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';
process.env.DISPATCH_INTERVAL_SECONDS = '0';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@platform/db';
import { SESSION_COOKIE_NAME } from '@platform/shared';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { EmailService, type EmailMessage } from '../src/notifications/email.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Forgot password.
 *
 * What matters most, in order:
 *   - the form never reveals whether an address has an account
 *   - a link works once, for an hour, and only the newest one works at all
 *   - using it locks out whoever else might have been signed in
 */

const OLD_PASSWORD = 'the-original-long-password';
const NEW_PASSWORD = 'a-brand-new-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

describe('Password reset (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  let send: MockInstance<(message: EmailMessage) => Promise<void>>;
  let counter = 0;

  const request = (method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

  async function person(): Promise<{ email: string; userId: string; session: string }> {
    counter += 1;
    const email = `e2e-reset-${counter}@example.test`;
    const response = await request('POST', '/api/v1/auth/register', {
      email,
      password: OLD_PASSWORD,
      organizationName: `Reset Test ${counter}`,
    });
    expect(response.statusCode, response.body).toBe(201);
    return { email, userId: JSON.parse(response.body).user.id, session: tokenOf(response) };
  }

  const forgot = (email: string) => request('POST', '/api/v1/auth/password/forgot', { email });
  const reset = (token: string, password = NEW_PASSWORD) =>
    request('POST', '/api/v1/auth/password/reset', { token, password });
  const login = (email: string, password: string) =>
    request('POST', '/api/v1/auth/login', { email, password });

  /** The token from the most recent reset email to this address. */
  function linkTokenFor(email: string): string {
    const message = [...send.mock.calls]
      .map((call) => call[0])
      .reverse()
      .find((m) => m.to === email && m.subject.startsWith('Reset'));
    expect(message, `no reset email to ${email}`).toBeDefined();
    return new URL(message!.link!).searchParams.get('token')!;
  }

  const resetEmailsTo = (email: string) =>
    send.mock.calls.filter((call) => call[0].to === email && call[0].subject.startsWith('Reset'))
      .length;

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-reset-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Reset Test%'");
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();
    send = vi.spyOn(app.get(EmailService), 'send').mockResolvedValue();
  });

  beforeEach(() => send.mockClear());

  afterAll(async () => {
    send?.mockRestore();
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('asking for a link', () => {
    it('answers an unknown address exactly as it answers a real one', async () => {
      const real = await person();

      const known = await forgot(real.email);
      const unknown = await forgot('e2e-reset-nobody@example.test');

      expect(unknown.statusCode).toBe(known.statusCode);
      expect(unknown.body).toBe(known.body);
      expect(send.mock.calls.map((c) => c[0].to)).toEqual([real.email]);
    });

    it('emails a link whose token is stored only as a hash', async () => {
      const { email, userId } = await person();

      expect((await forgot(email)).statusCode).toBe(202);

      const token = linkTokenFor(email);
      const rows = await privileged.passwordResetToken.findMany({ where: { userId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).not.toContain(token);
      expect(rows[0]!.tokenHash).toHaveLength(64);
    });

    it('sends at most one email a minute, however often the form is sent', async () => {
      const { email } = await person();

      await forgot(email);
      await forgot(email);
      await forgot(email);

      expect(resetEmailsTo(email)).toBe(1);
    });

    it('sends nothing to a suspended account', async () => {
      const { email, userId } = await person();
      await privileged.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });

      expect((await forgot(email)).statusCode).toBe(202);
      expect(resetEmailsTo(email)).toBe(0);
    });
  });

  // =========================================================================

  describe('using the link', () => {
    it('changes the password: the old one stops working and the new one works', async () => {
      const { email } = await person();
      await forgot(email);

      const response = await reset(linkTokenFor(email));
      expect(response.statusCode, response.body).toBe(204);

      expect((await login(email, OLD_PASSWORD)).statusCode).toBe(401);
      expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('signs out every device that was signed in', async () => {
      const { email, session } = await person();
      expect((await request('GET', '/api/v1/auth/me', undefined, session)).statusCode).toBe(200);

      await forgot(email);
      await reset(linkTokenFor(email));

      expect((await request('GET', '/api/v1/auth/me', undefined, session)).statusCode).toBe(401);
    });

    it('tells the person their password was changed', async () => {
      const { email } = await person();
      await forgot(email);
      await reset(linkTokenFor(email));

      expect(
        send.mock.calls.some((c) => c[0].to === email && c[0].subject.includes('was changed')),
      ).toBe(true);
    });

    it('clears a sign-in lockout', async () => {
      const { email, userId } = await person();
      await privileged.user.update({
        where: { id: userId },
        data: { failedLoginAttempts: 10, lockedUntil: new Date(Date.now() + 3_600_000) },
      });

      await forgot(email);
      await reset(linkTokenFor(email));

      expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('works once', async () => {
      const { email } = await person();
      await forgot(email);
      const token = linkTokenFor(email);

      expect((await reset(token)).statusCode).toBe(204);

      const again = await reset(token, 'yet-another-long-password');
      expect(again.statusCode).toBe(400);
      expect((await login(email, 'yet-another-long-password')).statusCode).toBe(401);
    });

    it('works once even when used twice at the same moment', async () => {
      const { email } = await person();
      await forgot(email);
      const token = linkTokenFor(email);

      const results = await Promise.all([
        reset(token, 'first-tab-long-password'),
        reset(token, 'second-tab-long-password'),
      ]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400]);
    });

    it('stops working after an hour', async () => {
      const { email, userId } = await person();
      await forgot(email);
      const token = linkTokenFor(email);
      await privileged.passwordResetToken.updateMany({
        where: { userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect((await reset(token)).statusCode).toBe(400);
      expect((await login(email, OLD_PASSWORD)).statusCode).toBe(200);
    });

    it('only honours the newest link', async () => {
      const { email, userId } = await person();
      await forgot(email);
      const first = linkTokenFor(email);

      // Past the one-a-minute limit, so a second link is issued.
      await privileged.passwordResetToken.updateMany({
        where: { userId },
        data: { createdAt: new Date(Date.now() - 120_000) },
      });
      await forgot(email);
      const second = linkTokenFor(email);
      expect(second).not.toBe(first);

      expect((await reset(first)).statusCode).toBe(400);
      expect((await reset(second)).statusCode).toBe(204);
    });

    it('gives the same answer for a link that never existed', async () => {
      const { email } = await person();
      await forgot(email);
      const real = linkTokenFor(email);
      await reset(real);

      const used = await reset(real);
      const madeUp = await reset('not-a-real-token');

      expect(madeUp.statusCode).toBe(400);
      expect(JSON.parse(madeUp.body).message).toBe(JSON.parse(used.body).message);
    });

    it('holds a new password to the same rules as sign-up', async () => {
      const { email } = await person();
      await forgot(email);
      const token = linkTokenFor(email);

      expect((await reset(token, 'short')).statusCode).toBe(400);
      expect((await reset(token, email)).statusCode).toBe(400);

      // Neither attempt used the link up.
      expect((await reset(token)).statusCode).toBe(204);
    });
  });
});
