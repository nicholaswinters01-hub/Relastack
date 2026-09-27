import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';
process.env.DISPATCH_INTERVAL_SECONDS = '0';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Quick search.
 *
 * One rule carries it: search shows nothing the list pages would not. Every
 * test here is a way that rule could quietly break.
 */

const PASSWORD = 'a-sufficiently-long-password';
const TERM = 'zebra';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

interface Actor {
  token: string;
  membershipId: string;
}

interface Result {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

describe('Quick search (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let organizationId: string;
  let admin: Actor;
  let manager: Actor;
  let otherToken: string;

  let downtownId: string;
  let northsideId: string;

  const request = (
    method: 'GET' | 'POST' | 'DELETE',
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

  const json = (response: InjectResult) => JSON.parse(response.body);

  async function search(token: string, q = TERM): Promise<Result[]> {
    const response = await request('GET', `/api/v1/search?q=${encodeURIComponent(q)}`, token);
    expect(response.statusCode, response.body).toBe(200);
    return json(response).results;
  }

  const titles = (results: Result[], kind: string) =>
    results.filter((r) => r.kind === kind).map((r) => r.title);

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-search-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Search Test%'");
  }

  async function addPerson(slug: string, locationIds: string[]): Promise<Actor> {
    const email = `e2e-search-${slug}@example.test`;
    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName: `Search Test Throwaway ${slug}`,
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const userId = json(registration).user.id;

    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `Search Test Throwaway ${slug}` } });

    const membership = await privileged.organizationMembership.create({
      data: { userId, organizationId, role: 'MEMBER' },
    });
    const assignment = await privileged.membershipRole.create({
      data: {
        membershipId: membership.id,
        roleId: SYSTEM_ROLE_IDS.location_manager,
        scope: 'LOCATION',
        organizationId,
      },
    });
    for (const locationId of locationIds) {
      await privileged.membershipRoleLocation.create({
        data: { membershipRoleId: assignment.id, locationId, organizationId },
      });
    }

    const login = await request('POST', '/api/v1/auth/login', undefined, {
      email,
      password: PASSWORD,
    });
    return {
      token: login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value,
      membershipId: membership.id,
    };
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-search-admin@example.test',
      password: PASSWORD,
      organizationName: 'Search Test Company',
    });
    const adminToken = registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const adminMembership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(registration).user.id },
    });
    organizationId = adminMembership.organizationId;
    admin = { token: adminToken, membershipId: adminMembership.id };

    await request('POST', `/api/v1/modules/${MODULES.CRM}`, adminToken);
    await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, adminToken);

    downtownId = json(
      await request('POST', '/api/v1/locations', adminToken, { name: 'Downtown', timezone: 'UTC' }),
    ).location.id;
    northsideId = json(
      await request('POST', '/api/v1/locations', adminToken, {
        name: 'Northside',
        timezone: 'UTC',
      }),
    ).location.id;

    manager = await addPerson('manager', [downtownId]);

    const customer = (displayName: string, locationId: string) =>
      privileged.customer.create({
        data: { organizationId, displayName, type: 'PERSON', stage: 'ACTIVE', locationId },
        select: { id: true },
      });
    const downtownCustomer = await customer('Zebra Downtown Dana', downtownId);
    const northsideCustomer = await customer('Zebra Northside Nils', northsideId);

    const day = new Date(Date.now() + 2 * 86_400_000);
    const job = (title: string, locationId: string, customerId: string, hour: number) =>
      request('POST', '/api/v1/jobs', adminToken, {
        title,
        locationId,
        customerId,
        startsAt: new Date(day.getTime() + hour * 3_600_000).toISOString(),
        endsAt: new Date(day.getTime() + (hour + 1) * 3_600_000).toISOString(),
        acknowledgeConflicts: true,
      });
    expect((await job('Zebra lawn downtown', downtownId, downtownCustomer.id, 1)).statusCode).toBe(
      201,
    );
    expect(
      (await job('Zebra hedge northside', northsideId, northsideCustomer.id, 3)).statusCode,
    ).toBe(201);

    // Handed to the manager, sitting at a branch they do not run, about a
    // customer they may not see. Visible to them; the customer must not be.
    const task = await request('POST', '/api/v1/tasks', adminToken, {
      title: 'Zebra follow-up call',
      locationId: northsideId,
      customerId: northsideCustomer.id,
      assigneeMembershipId: manager.membershipId,
    });
    expect(task.statusCode, task.body).toBe(201);

    // A competitor with matching names, for isolation.
    const other = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-search-other@example.test',
      password: PASSWORD,
      organizationName: 'Search Test Rival',
    });
    otherToken = other.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    await request('POST', `/api/v1/modules/${MODULES.CRM}`, otherToken);
    const rivalId = (
      await privileged.organizationMembership.findFirstOrThrow({
        where: { userId: json(other).user.id },
      })
    ).organizationId;
    await privileged.customer.create({
      data: {
        organizationId: rivalId,
        displayName: 'Zebra Rival Rita',
        type: 'PERSON',
        stage: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  it('finds customers, jobs, tasks and locations, each linking to its own page', async () => {
    const results = await search(admin.token);

    expect(titles(results, 'customer').sort()).toEqual([
      'Zebra Downtown Dana',
      'Zebra Northside Nils',
    ]);
    expect(titles(results, 'job').sort()).toEqual(['Zebra hedge northside', 'Zebra lawn downtown']);
    expect(titles(results, 'task')).toEqual(['Zebra follow-up call']);

    const job = results.find((r) => r.kind === 'job')!;
    expect(job.href).toBe(`/jobs/${job.id}`);

    const places = await search(admin.token, 'northside');
    expect(titles(places, 'location')).toEqual(['Northside']);
  });

  it('never returns another business’s records', async () => {
    expect(titles(await search(admin.token), 'customer')).not.toContain('Zebra Rival Rita');

    const rival = await search(otherToken);
    expect(rival.map((r) => r.title)).toEqual(['Zebra Rival Rita']);
  });

  it('shows a branch manager only their own branch, exactly as the lists do', async () => {
    const results = await search(manager.token);

    expect(titles(results, 'customer')).toEqual(['Zebra Downtown Dana']);
    expect(titles(results, 'job')).toEqual(['Zebra lawn downtown']);

    // Same answer as the customer list itself, not a second opinion.
    const listed = json(
      await request('GET', `/api/v1/customers?search=${TERM}`, manager.token),
    ).customers.map((c: { displayName: string }) => c.displayName);
    expect(titles(results, 'customer')).toEqual(listed);
  });

  it('shows the manager their task without the customer it concerns', async () => {
    const results = await search(manager.token);
    const task = results.find((r) => r.kind === 'task');

    expect(task?.title).toBe('Zebra follow-up call');
    expect(task?.subtitle).toBeNull();
    expect(JSON.stringify(results)).not.toContain('Northside Nils');
  });

  it('finds nothing in a module the business has switched off', async () => {
    // Scheduling needs Customers, so it goes off first.
    const off = async (key: string) =>
      expect((await request('DELETE', `/api/v1/modules/${key}`, admin.token)).statusCode).toBe(200);
    await off(MODULES.SCHEDULING);
    await off(MODULES.CRM);
    try {
      const results = await search(admin.token);
      expect(titles(results, 'customer')).toEqual([]);
      expect(titles(results, 'job')).toEqual([]);
      // Tasks are core and still found.
      expect(titles(results, 'task')).toEqual(['Zebra follow-up call']);
    } finally {
      await request('POST', `/api/v1/modules/${MODULES.CRM}`, admin.token);
      await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, admin.token);
    }
  });

  it('asks for at least two characters', async () => {
    const response = await request('GET', '/api/v1/search?q=z', admin.token);
    expect(response.statusCode).toBe(400);
  });

  it('requires signing in', async () => {
    expect((await request('GET', `/api/v1/search?q=${TERM}`)).statusCode).toBe(401);
  });
});
