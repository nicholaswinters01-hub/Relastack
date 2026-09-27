import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadServerEnv } from '@platform/config';
import type { PrismaClient } from '@platform/db';
import { SESSION_COOKIE_NAME } from '@platform/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * What production switches on: the internal gate, per-client rate limiting
 * behind it, and invite-only sign-up.
 *
 * Every request in production arrives from the web tier's servers, so these
 * are what stand between "one busy user throttles everyone" and "anyone can
 * register a business".
 */

const SECRET = 'an-internal-secret-at-least-32-characters-long';
const ACCESS_CODE = 'research-2026';
const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

describe('Deployment protections (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  const saved = {
    INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET,
    SIGNUP_ACCESS_CODE: process.env.SIGNUP_ACCESS_CODE,
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
  };

  /** A request as the web tier sends it: the secret, and the real client's address. */
  const viaWeb = (
    method: 'GET' | 'POST',
    url: string,
    clientIp: string,
    payload?: unknown,
    extra: Record<string, string> = {},
    cookie?: string,
  ) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: {
        'x-internal-secret': SECRET,
        'x-client-ip': clientIp,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...extra,
      },
      cookies: cookie ? { [SESSION_COOKIE_NAME]: cookie } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (r: InjectResult) => JSON.parse(r.body);

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-deploy-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Deploy Test%'");
  }

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = SECRET;
    process.env.SIGNUP_ACCESS_CODE = ACCESS_CODE;
    process.env.RATE_LIMIT_ENABLED = 'true';

    app = (await createTestApp()).app;
    privileged = createPrivilegedTestClient();
    await cleanUp();
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // =========================================================================

  describe('only the web tier gets in', () => {
    it('refuses a request with no secret, as if the route did not exist', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });

      expect(response.statusCode).toBe(404);
    });

    it('refuses a wrong secret the same way', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { 'x-internal-secret': SECRET.replace(/.$/, '!') },
      });

      expect(response.statusCode).toBe(404);
    });

    it('lets the host check the process is alive without the secret', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health/live' });

      expect(response.statusCode).toBe(200);
    });

    it('does not open the full health report, which touches the database', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

      expect(response.statusCode).toBe(404);
    });

    it('lets the web tier through to the route', async () => {
      const response = await viaWeb('GET', '/api/v1/auth/me', '203.0.113.1');

      // Reached the route: unauthenticated, not hidden.
      expect(response.statusCode).toBe(401);
    });
  });

  // =========================================================================

  describe('rate limits count the real client, not the web server', () => {
    const limit = loadServerEnv().RATE_LIMIT_LOGIN_PER_MINUTE;
    const attempt = (clientIp: string) =>
      viaWeb('POST', '/api/v1/auth/login', clientIp, {
        email: 'e2e-deploy-nobody@example.test',
        password: 'wrong-password-entirely',
      });

    it('throttles one client once it passes the limit', async () => {
      for (let i = 0; i < limit; i++) {
        expect((await attempt('198.51.100.10')).statusCode).not.toBe(429);
      }

      expect((await attempt('198.51.100.10')).statusCode).toBe(429);
    });

    it('does not throttle a different client behind the same web server', async () => {
      // Every production request comes from a few Vercel addresses. Without
      // this, one busy user would lock everyone out.
      expect((await attempt('198.51.100.11')).statusCode).not.toBe(429);
    });

    it('does not let a malformed address buy a fresh allowance each time', async () => {
      // Anything that is not an IP falls back to the socket address, so these
      // all share one bucket rather than each getting their own.
      for (let i = 0; i < limit; i++) {
        expect((await attempt(`not-an-ip-${i}`)).statusCode).not.toBe(429);
      }

      expect((await attempt('not-an-ip-final')).statusCode).toBe(429);
    });
  });

  // =========================================================================

  describe('invite-only sign-up', () => {
    const register = (email: string, clientIp: string, accessCode?: string) =>
      viaWeb('POST', '/api/v1/auth/register', clientIp, {
        email,
        password: PASSWORD,
        organizationName: 'Deploy Test Company',
        ...(accessCode === undefined ? {} : { accessCode }),
      });

    it('refuses sign-up without the code, and says which field', async () => {
      const response = await register('e2e-deploy-nocode@example.test', '192.0.2.1');

      expect(response.statusCode).toBe(400);
      expect(json(response).errors).toEqual([
        { field: 'accessCode', message: 'That access code is not valid' },
      ]);
      expect(
        await privileged.user.count({ where: { email: 'e2e-deploy-nocode@example.test' } }),
      ).toBe(0);
    });

    it('refuses a wrong code the same way', async () => {
      const response = await register(
        'e2e-deploy-wrong@example.test',
        '192.0.2.2',
        'research-2025',
      );

      expect(response.statusCode).toBe(400);
      expect(json(response).errors[0].field).toBe('accessCode');
    });

    it('accepts the right code', async () => {
      const response = await register('e2e-deploy-owner@example.test', '192.0.2.3', ACCESS_CODE);

      expect(response.statusCode, response.body).toBe(201);
    });

    it('never asks an invited employee for the code', async () => {
      // The invitation link is the authorization. Asking an owner's staff for
      // a research code would lock out exactly the people they invited.
      const login = await viaWeb('POST', '/api/v1/auth/login', '192.0.2.4', {
        email: 'e2e-deploy-owner@example.test',
        password: PASSWORD,
      });
      const ownerSession = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      const invitation = await viaWeb(
        'POST',
        '/api/v1/invitations',
        '192.0.2.4',
        {
          email: 'e2e-deploy-employee@example.test',
          roleKey: 'employee',
          scope: 'ORGANIZATION',
          locationIds: [],
        },
        {},
        ownerSession,
      );
      expect(invitation.statusCode, invitation.body).toBe(201);

      const token = new URL(json(invitation).acceptUrl).searchParams.get('token')!;
      const accepted = await viaWeb('POST', '/api/v1/invitations/accept', '192.0.2.5', {
        token,
        password: PASSWORD,
      });

      expect(accepted.statusCode, accepted.body).toBe(200);
    });
  });
});
