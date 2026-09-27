import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@platform/db';
import { SESSION_COOKIE_NAME } from '@platform/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Running the way production runs: background delivery on, and a database
 * that goes to sleep when idle.
 *
 * The notifications suite switches background delivery off so nothing races
 * its assertions. This one leaves it on, because what matters here is that
 * nobody has to drain anything by hand.
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

describe('Delivery and database sleep (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  let organizationId: string;
  let ownerToken: string;
  let crewMembershipId: string;
  const saved = {
    DISPATCH_INTERVAL_SECONDS: process.env.DISPATCH_INTERVAL_SECONDS,
    SIGNUP_ACCESS_CODE: process.env.SIGNUP_ACCESS_CODE,
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
  };

  const request = (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (r: InjectResult) => JSON.parse(r.body);

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-delivery-%@example.test'",
    );
    await privileged.$executeRawUnsafe(
      "DELETE FROM organizations WHERE name LIKE 'Delivery Test%'",
    );
  }

  beforeAll(async () => {
    process.env.DISPATCH_INTERVAL_SECONDS = '3600';
    process.env.RATE_LIMIT_ENABLED = 'false';
    delete process.env.SIGNUP_ACCESS_CODE;

    app = (await createTestApp()).app;
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const owner = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-delivery-owner@example.test',
      password: PASSWORD,
      organizationName: 'Delivery Test Company',
    });
    ownerToken = owner.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    organizationId = (
      await privileged.organizationMembership.findFirstOrThrow({
        where: { userId: json(owner).user.id },
      })
    ).organizationId;

    // Someone to assign work to, moved into the owner's business.
    const crew = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-delivery-crew@example.test',
      password: PASSWORD,
      organizationName: 'Delivery Test Throwaway',
    });
    const crewUserId = json(crew).user.id;
    await privileged.organizationMembership.deleteMany({ where: { userId: crewUserId } });
    await privileged.organization.deleteMany({ where: { name: 'Delivery Test Throwaway' } });
    crewMembershipId = (
      await privileged.organizationMembership.create({
        data: { userId: crewUserId, organizationId, role: 'MEMBER' },
      })
    ).id;
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

  it('turns an event into a notification within seconds, with nobody draining by hand', async () => {
    const created = await request('POST', '/api/v1/tasks', ownerToken, {
      title: 'Check the irrigation',
      assigneeMembershipId: crewMembershipId,
    });
    expect(created.statusCode, created.body).toBe(201);

    // About a second is expected; three leaves room without hiding a regression
    // to the five-second startup pass.
    const deadline = Date.now() + 3_000;
    let delivered = 0;

    while (Date.now() < deadline) {
      delivered = await privileged.notification.count({
        where: { membershipId: crewMembershipId },
      });
      if (delivered > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(delivered).toBe(1);
  });

  it('keeps working after the database drops every connection, as Neon does when it sleeps', async () => {
    // Neon closes all connections when it suspends an idle database. The next
    // request must reconnect rather than fail in front of whoever made it.
    await privileged.$executeRawUnsafe(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE usename = 'platform_app' AND pid <> pg_backend_pid()
    `);

    const response = await request('GET', '/api/v1/tasks', ownerToken);

    expect(response.statusCode, response.body).toBe(200);
  });
});
