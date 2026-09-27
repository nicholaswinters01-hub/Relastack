import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';
process.env.DISPATCH_INTERVAL_SECONDS = '0';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@platform/db';
import { MODULES, SESSION_COOKIE_NAME } from '@platform/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * The "Get started" checklist: every step is worked out from the account
 * itself, and only the people who run the business are asked.
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

describe('Get started checklist (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  let owner: string;

  const request = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    token?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (r: InjectResult) => JSON.parse(r.body);
  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  const progress = async (token: string) =>
    json(await request('GET', '/api/v1/organizations/current/setup', token));

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-setup-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Setup Test%'");
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const registered = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-setup-owner@example.test',
      password: PASSWORD,
      organizationName: 'Setup Test Company',
    });
    expect(registered.statusCode, registered.body).toBe(201);
    owner = tokenOf(registered);
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  it('starts with nothing done, and ticks each step off as it really happens', async () => {
    expect(await progress(owner)).toEqual({
      hasName: false,
      hasModules: false,
      hasLocation: false,
      hasTeammate: false,
      hasCustomer: false,
      hasJob: false,
    });

    await request('PATCH', '/api/v1/auth/me', owner, { firstName: 'Sam', lastName: '' });
    await request('POST', `/api/v1/modules/${MODULES.CRM}`, owner);
    await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, owner);
    const location = json(
      await request('POST', '/api/v1/locations', owner, { name: 'Tampa', timezone: 'UTC' }),
    ).location;
    await request('POST', '/api/v1/invitations', owner, {
      email: 'e2e-setup-crew@example.test',
      roleKey: 'employee',
      scope: 'ORGANIZATION',
      locationIds: [],
    });
    const customer = json(
      await request('POST', '/api/v1/customers', owner, {
        firstName: 'First',
        locationId: location.id,
      }),
    ).customer;
    const start = new Date(Date.now() + 86_400_000);
    const job = await request('POST', '/api/v1/jobs', owner, {
      title: 'First job',
      locationId: location.id,
      customerId: customer.id,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
    });
    expect(job.statusCode, job.body).toBe(201);

    expect(await progress(owner)).toEqual({
      hasName: true,
      hasModules: true,
      hasLocation: true,
      hasTeammate: true,
      hasCustomer: true,
      hasJob: true,
    });
  });

  it('is only for the people who run the business', async () => {
    const invited = await request('POST', '/api/v1/invitations', owner, {
      email: 'e2e-setup-employee@example.test',
      roleKey: 'employee',
      scope: 'ORGANIZATION',
      locationIds: [],
    });
    const accepted = await request('POST', '/api/v1/invitations/accept', undefined, {
      token: new URL(json(invited).acceptUrl).searchParams.get('token'),
      password: PASSWORD,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    const response = await request('GET', '/api/v1/organizations/current/setup', tokenOf(accepted));
    expect(response.statusCode).toBe(403);
  });
});
