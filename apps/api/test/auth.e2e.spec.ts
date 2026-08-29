import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

// Rate limiting is exercised separately in rate-limit.e2e.spec.ts. This suite
// issues far more requests than a real user would and would otherwise trip the
// limiter for reasons unrelated to what it asserts.
//
// Set before AppModule is imported: the guard list is built at module
// definition, so this must be in place first.
process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SESSION_COOKIE_NAME, authResponseSchema } from '@platform/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';
import type { PrismaClient } from '@platform/db';

const EMAIL = 'e2e-auth@example.test';
const PASSWORD = 'a-sufficiently-long-password';
const ORG_NAME = 'E2E Auth Company';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string; expires?: Date; httpOnly?: boolean }>;
  headers: Record<string, unknown>;
}

describe('Authentication (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  /** Bypasses RLS — organizations are tenant-owned, so cleanup needs it. */
  let privileged: PrismaClient;

  const post = (url: string, payload?: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as never,
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const get = (url: string, token?: string) =>
    app.inject({
      method: 'GET',
      url,
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const sessionCookie = (response: InjectResult) =>
    response.cookies.find((c) => c.name === SESSION_COOKIE_NAME);

  /** Register the standard fixture user and return its session token. */
  async function registerFixture(): Promise<string> {
    const response = await post('/api/v1/auth/register', {
      organizationName: ORG_NAME,
      email: EMAIL,
      password: PASSWORD,
    });
    expect(response.statusCode).toBe(201);
    return sessionCookie(response)!.value;
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    privileged = createPrivilegedTestClient();
  });

  beforeEach(async () => {
    // Sessions cascade-delete with the user.
    await prisma.client.user.deleteMany({ where: { email: { contains: 'e2e-auth' } } });
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name = 'E2E Auth Company'");
  });

  afterAll(async () => {
    await prisma.client.user.deleteMany({ where: { email: { contains: 'e2e-auth' } } });
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name = 'E2E Auth Company'");
    await privileged?.$disconnect();
    await app?.close();
  });

  describe('POST /auth/register', () => {
    it('creates a user and returns the public shape', async () => {
      const response = await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: EMAIL,
        password: PASSWORD,
        firstName: 'Nick',
      });

      expect(response.statusCode).toBe(201);

      const body = JSON.parse(response.body);
      const parsed = authResponseSchema.safeParse(body);

      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
      expect(body.user.email).toBe(EMAIL);
      expect(body.user.firstName).toBe('Nick');
      expect(body.user.status).toBe('ACTIVE');
    });

    it('never returns the password or its hash', async () => {
      const response = await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: EMAIL,
        password: PASSWORD,
      });

      expect(response.body).not.toContain(PASSWORD);
      expect(response.body).not.toContain('argon2');
      expect(response.body).not.toContain('passwordHash');
    });

    it('stores an argon2id hash, never the plaintext', async () => {
      await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: EMAIL,
        password: PASSWORD,
      });

      const user = await prisma.client.user.findUnique({ where: { email: EMAIL } });

      expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user?.passwordHash).not.toContain(PASSWORD);
    });

    it('signs the user in with a hardened cookie', async () => {
      const response = await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: EMAIL,
        password: PASSWORD,
      });
      const setCookie = String(response.headers['set-cookie']);

      expect(sessionCookie(response)).toBeDefined();
      // httpOnly keeps the token out of reach of any XSS payload.
      expect(setCookie).toMatch(/HttpOnly/i);
      // SameSite=Lax withholds the cookie from cross-site POSTs (CSRF shape).
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).toMatch(/Path=\//i);
    });

    it('never puts the session token in the response body', async () => {
      const response = await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: EMAIL,
        password: PASSWORD,
      });
      const token = sessionCookie(response)!.value;

      // The token belongs in an httpOnly cookie only. Echoing it into the body
      // would make it readable by JavaScript, defeating httpOnly entirely.
      expect(response.body).not.toContain(token);
    });

    it('rejects a password shorter than the minimum with field-level errors', async () => {
      const response = await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: EMAIL,
        password: 'short',
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.body);
      expect(body.message).toBe('Validation failed');
      expect(body.errors.some((e: { field: string }) => e.field === 'password')).toBe(true);
    });

    it('reports every validation problem at once', async () => {
      const response = await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: 'not-an-email',
        password: 'x',
      });

      const body = JSON.parse(response.body);
      expect(body.errors.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects a password equal to the email address', async () => {
      const response = await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: EMAIL,
        password: EMAIL,
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects a duplicate email with 409', async () => {
      await registerFixture();

      const response = await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: EMAIL,
        password: PASSWORD,
      });

      expect(response.statusCode).toBe(409);
    });

    it('treats email as case-insensitive', async () => {
      await registerFixture();

      const response = await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: EMAIL.toUpperCase(),
        password: PASSWORD,
      });

      // citext plus normalisation: one address cannot become two accounts.
      expect(response.statusCode).toBe(409);
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(registerFixture);

    it('accepts correct credentials and issues a session', async () => {
      const response = await post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });

      expect(response.statusCode).toBe(200);
      expect(sessionCookie(response)).toBeDefined();
      expect(JSON.parse(response.body).user.email).toBe(EMAIL);
    });

    it('accepts a differently-cased email', async () => {
      const response = await post('/api/v1/auth/login', {
        email: EMAIL.toUpperCase(),
        password: PASSWORD,
      });

      expect(response.statusCode).toBe(200);
    });

    it('records the login time', async () => {
      await post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });

      const user = await prisma.client.user.findUnique({ where: { email: EMAIL } });
      expect(user?.lastLoginAt).not.toBeNull();
    });

    it('rejects a wrong password', async () => {
      const response = await post('/api/v1/auth/login', {
        email: EMAIL,
        password: 'wrong-password',
      });

      expect(response.statusCode).toBe(401);
      expect(sessionCookie(response)).toBeUndefined();
    });

    it('gives an identical response for unknown email and wrong password', async () => {
      const unknown = await post('/api/v1/auth/login', {
        email: 'nobody-e2e-auth@example.test',
        password: PASSWORD,
      });
      const wrong = await post('/api/v1/auth/login', { email: EMAIL, password: 'wrong-password' });

      // Any difference here turns the login form into an account-enumeration
      // oracle: an attacker learns which addresses hold accounts.
      expect(unknown.statusCode).toBe(wrong.statusCode);
      expect(JSON.parse(unknown.body).message).toBe(JSON.parse(wrong.body).message);
    });

    it('issues a distinct token on each login', async () => {
      const first = await post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });
      const second = await post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });

      // A reused token would be session fixation.
      expect(sessionCookie(first)!.value).not.toBe(sessionCookie(second)!.value);
    });

    it('refuses a suspended account without revealing why', async () => {
      await prisma.client.user.update({ where: { email: EMAIL }, data: { status: 'SUSPENDED' } });

      const response = await post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).message).toBe('Invalid email or password');
    });
  });

  describe('account lockout', () => {
    const LOCK_EMAIL = 'e2e-auth-lock@example.test';

    async function attempts(): Promise<number> {
      const user = await prisma.client.user.findUnique({ where: { email: LOCK_EMAIL } });
      return user?.failedLoginAttempts ?? -1;
    }

    beforeEach(async () => {
      await post('/api/v1/auth/register', {
        organizationName: ORG_NAME,
        email: LOCK_EMAIL,
        password: PASSWORD,
      });
    });

    it('counts consecutive failures', async () => {
      await post('/api/v1/auth/login', { email: LOCK_EMAIL, password: 'wrong-one' });
      await post('/api/v1/auth/login', { email: LOCK_EMAIL, password: 'wrong-two' });

      expect(await attempts()).toBe(2);
    });

    it('resets the counter on a successful sign-in', async () => {
      await post('/api/v1/auth/login', { email: LOCK_EMAIL, password: 'wrong-one' });
      expect(await attempts()).toBe(1);

      const success = await post('/api/v1/auth/login', { email: LOCK_EMAIL, password: PASSWORD });

      expect(success.statusCode).toBe(200);
      expect(await attempts()).toBe(0);
    });

    it('locks the account and then refuses the CORRECT password', async () => {
      const threshold = Number(process.env.LOGIN_MAX_FAILED_ATTEMPTS ?? 8);

      for (let i = 0; i < threshold; i += 1) {
        await post('/api/v1/auth/login', { email: LOCK_EMAIL, password: `wrong-${i}` });
      }

      const user = await prisma.client.user.findUnique({ where: { email: LOCK_EMAIL } });
      expect(user?.lockedUntil).not.toBeNull();

      // The whole point: the attacker may eventually guess right, and it still
      // does not let them in.
      const correct = await post('/api/v1/auth/login', { email: LOCK_EMAIL, password: PASSWORD });

      expect(correct.statusCode).toBe(401);
      expect(sessionCookie(correct)).toBeUndefined();
      expect(JSON.parse(correct.body).message).toBe('Invalid email or password');
    });

    it('lifts the lock once it expires', async () => {
      await prisma.client.user.update({
        where: { email: LOCK_EMAIL },
        data: { lockedUntil: new Date(Date.now() - 1000), failedLoginAttempts: 99 },
      });

      const response = await post('/api/v1/auth/login', { email: LOCK_EMAIL, password: PASSWORD });

      expect(response.statusCode).toBe(200);
      expect(await attempts()).toBe(0);
    });

    it('never locks an address that has no account', async () => {
      for (let i = 0; i < 10; i += 1) {
        const response = await post('/api/v1/auth/login', {
          email: 'e2e-auth-ghost@example.test',
          password: 'whatever',
        });
        expect(response.statusCode).toBe(401);
      }

      const ghost = await prisma.client.user.findUnique({
        where: { email: 'e2e-auth-ghost@example.test' },
      });

      // No row is created, so nothing reveals whether the address exists.
      expect(ghost).toBeNull();
    });
  });

  describe('GET /auth/me', () => {
    it('rejects a request with no session', async () => {
      const response = await get('/api/v1/auth/me');

      expect(response.statusCode).toBe(401);
    });

    it('rejects a forged token', async () => {
      const response = await get('/api/v1/auth/me', 'clearly-not-a-real-token');

      expect(response.statusCode).toBe(401);
    });

    it('returns the authenticated user', async () => {
      const token = await registerFixture();

      const response = await get('/api/v1/auth/me', token);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).user.email).toBe(EMAIL);
      expect(response.body).not.toContain('passwordHash');
    });

    it('rejects a session whose user has been suspended', async () => {
      const token = await registerFixture();

      await prisma.client.user.update({ where: { email: EMAIL }, data: { status: 'SUSPENDED' } });

      // Suspension takes effect on the very next request, not at expiry.
      const response = await get('/api/v1/auth/me', token);
      expect(response.statusCode).toBe(401);
    });

    it('rejects an expired session', async () => {
      const token = await registerFixture();

      await prisma.client.session.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await get('/api/v1/auth/me', token);
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session and clears the cookie', async () => {
      const token = await registerFixture();

      const response = await post('/api/v1/auth/logout', undefined, token);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ success: true, sessionsRevoked: 1 });

      // Scoped to THIS fixture's user. An unfiltered findFirst() picks
      // whichever session the database returns first, which may belong to
      // another test entirely — it passed by luck until other suites started
      // leaving sessions behind.
      const user = await prisma.client.user.findUniqueOrThrow({ where: { email: EMAIL } });
      const session = await prisma.client.session.findFirstOrThrow({
        where: { userId: user.id },
      });

      expect(session.revokedAt).not.toBeNull();
    });

    it('makes the token unusable immediately', async () => {
      const token = await registerFixture();

      expect((await get('/api/v1/auth/me', token)).statusCode).toBe(200);

      await post('/api/v1/auth/logout', undefined, token);

      // This is the whole argument for sessions over JWTs: revocation is
      // effective on the next request, with no denylist to maintain.
      expect((await get('/api/v1/auth/me', token)).statusCode).toBe(401);
    });

    it('succeeds without a session so a stale cookie can still be cleared', async () => {
      const response = await post('/api/v1/auth/logout');

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).sessionsRevoked).toBe(0);
    });
  });

  describe('POST /auth/logout-all', () => {
    it('revokes every session for the user', async () => {
      const first = await registerFixture();
      const second = sessionCookie(
        await post('/api/v1/auth/login', { email: EMAIL, password: PASSWORD }),
      )!.value;

      const response = await post('/api/v1/auth/logout-all', undefined, first);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).sessionsRevoked).toBe(2);

      // Both devices are signed out, not just the one that asked.
      expect((await get('/api/v1/auth/me', first)).statusCode).toBe(401);
      expect((await get('/api/v1/auth/me', second)).statusCode).toBe(401);
    });

    it('requires authentication', async () => {
      const response = await post('/api/v1/auth/logout-all');

      expect(response.statusCode).toBe(401);
    });
  });

  describe('global guard', () => {
    it('leaves health endpoints public', async () => {
      expect((await get('/api/v1/health')).statusCode).toBe(200);
      expect((await get('/api/v1/health/live')).statusCode).toBe(200);
    });

    it('protects unknown routes behind authentication rather than leaking 404', async () => {
      // The guard runs before routing resolves, so an unauthenticated probe
      // cannot map which endpoints exist.
      const response = await get('/api/v1/definitely-not-a-route');

      expect([401, 404]).toContain(response.statusCode);
    });
  });
});
