import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

// Stated explicitly rather than relying on the default, so this suite cannot
// be silently neutered by configuration drift.
process.env.RATE_LIMIT_ENABLED = 'true';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadServerEnv } from '@platform/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { PrismaClient } from '@platform/db';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

const PASSWORD = 'a-sufficiently-long-password';

/**
 * Rate limiting on the authentication endpoints.
 *
 * This matters more than it looks. Argon2 is expensive *by design* — that is
 * what makes offline cracking costly. Without a limit in front of it, an
 * attacker can turn our own password hardening into a denial-of-service vector
 * simply by submitting wrong passwords repeatedly.
 *
 * It is also the primary defence against online credential stuffing.
 *
 * Limits are read from configuration rather than hard-coded here, so tuning
 * them in .env does not silently invalidate this suite.
 */
describe('Rate limiting (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  /** Organizations are tenant-owned, so cleanup needs the RLS-bypassing role. */
  let privileged: PrismaClient;

  const env = loadServerEnv();

  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, payload: payload as never }) as unknown as Promise<{
      statusCode: number;
      body: string;
    }>;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();
  });

  /**
   * Registration creates an organization as well as a user, and organizations
   * are not cascade-deleted by removing the user — so both must be cleaned up
   * or every run leaves rows behind.
   */
  async function cleanUp(): Promise<void> {
    await prisma.client.user.deleteMany({ where: { email: { contains: 'e2e-rate' } } });
    await privileged.$executeRawUnsafe(
      "DELETE FROM organizations WHERE name LIKE 'Rate Limit Test Co %'",
    );
  }

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  it('blocks repeated failed logins once the limit is exceeded', async () => {
    const attempts = env.RATE_LIMIT_LOGIN_PER_MINUTE + 2;
    const statuses: number[] = [];

    for (let i = 0; i < attempts; i += 1) {
      const response = await post('/api/v1/auth/login', {
        email: 'e2e-rate@example.test',
        password: 'wrong-password',
      });
      statuses.push(response.statusCode);
    }

    // Early attempts are ordinary auth failures; the limiter then takes over.
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
    expect(statuses).toContain(429);

    // Once limited, it stays limited for the window.
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  it('limits registration attempts', async () => {
    const attempts = env.RATE_LIMIT_REGISTER_PER_HOUR + 2;
    const statuses: number[] = [];

    for (let i = 0; i < attempts; i += 1) {
      const response = await post('/api/v1/auth/register', {
        email: `e2e-rate-${i}@example.test`,
        password: PASSWORD,
        organizationName: `Rate Limit Test Co ${i}`,
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.filter((s) => s === 201).length).toBeGreaterThan(0);
    expect(statuses).toContain(429);
  });
});
