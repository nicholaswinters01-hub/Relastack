import 'reflect-metadata';

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * How people are doing.
 *
 *   - a manager sees their branch's people, and only the work done there
 *   - an employee sees their own numbers and nobody else's
 *   - each measure appears only when the business has its module
 *   - work counts inside the period asked for, in the branch's own zone
 *   - a withdrawn contract counts neither way
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

interface Actor {
  token: string;
  membershipId: string;
}

interface Stat {
  count: number;
  detail: number | null;
}
interface Person {
  membershipId: string;
  name: string;
  stats: Record<string, Stat>;
}

describe('Performance (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let organizationId: string;
  let admin: Actor;
  let downtownManager: Actor;
  let northManager: Actor;
  let tech: Actor;
  let bystander: Actor;

  let downtownId: string;
  let northsideId: string;

  let otherToken: string;

  const AUGUST = 'from=2026-08-01&to=2026-08-31';

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
  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

  const team = async (token: string, query = AUGUST) => {
    const response = await request('GET', `/api/v1/performance?${query}`, token);
    expect(response.statusCode, response.body).toBe(200);
    return json(response) as {
      measures: string[];
      scope: { organizationWide: boolean; locations: Array<{ name: string }> };
      people: Person[];
      standouts: Array<{ measure: string; names: string[]; count: number }>;
    };
  };
  const statsOf = (people: Person[], actor: Actor) =>
    people.find((person) => person.membershipId === actor.membershipId)?.stats;

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-performance-%@example.test'",
    );
    await privileged.$executeRawUnsafe(
      "DELETE FROM organizations WHERE name LIKE 'Performance Test%'",
    );
  }

  async function register(slug: string, organizationName: string) {
    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email: `e2e-performance-${slug}@example.test`,
      password: PASSWORD,
      organizationName,
      firstName: slug,
    });
    return { token: tokenOf(response), userId: json(response).user.id as string };
  }

  async function addPerson(slug: string, roleId: string, locationIds: string[]): Promise<Actor> {
    const { userId } = await register(slug, `Performance Test Throwaway ${slug}`);
    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({
      where: { name: `Performance Test Throwaway ${slug}` },
    });
    const membership = await privileged.organizationMembership.create({
      data: { userId, organizationId, role: 'MEMBER' },
    });
    const assignment = await privileged.membershipRole.create({
      data: { membershipId: membership.id, roleId, scope: 'LOCATION', organizationId },
    });
    for (const locationId of locationIds) {
      await privileged.membershipRoleLocation.create({
        data: { membershipRoleId: assignment.id, locationId, organizationId },
      });
    }
    const login = await request('POST', '/api/v1/auth/login', undefined, {
      email: `e2e-performance-${slug}@example.test`,
      password: PASSWORD,
    });
    return { token: tokenOf(login), membershipId: membership.id };
  }

  const location = async (name: string) =>
    json(
      await request('POST', '/api/v1/locations', admin.token, {
        name,
        timezone: 'America/New_York',
      }),
    ).location.id as string;

  /** A job that finished at `completedAt`, booked to end at `endsAt`. */
  async function completedJob(
    locationId: string,
    crew: string[],
    endsAt: string,
    completedAt: string,
  ) {
    const end = new Date(endsAt);
    const job = await privileged.job.create({
      data: {
        organizationId,
        locationId,
        title: 'Visit',
        startsAt: new Date(end.getTime() - 60 * 60_000),
        endsAt: end,
        status: 'COMPLETED',
        completedAt: new Date(completedAt),
      },
    });
    for (const membershipId of crew) {
      await privileged.jobAssignment.create({
        data: { jobId: job.id, membershipId, organizationId },
      });
    }
  }

  async function customer(locationId: string | null, data: Record<string, unknown> = {}) {
    return privileged.customer.create({
      data: { organizationId, locationId, displayName: 'A customer', ...data },
    });
  }

  async function contract(
    locationId: string,
    sentBy: Actor,
    sentAt: string,
    status: 'SENT' | 'SIGNED' | 'VOIDED',
  ) {
    const { id: customerId } = await customer(locationId);
    await privileged.contract.create({
      data: {
        organizationId,
        customerId,
        provider: 'docusign',
        providerEnvelopeId: `env-${Math.random()}`,
        templateId: 't',
        templateName: 'Agreement',
        title: 'Agreement',
        signerName: 'Signer',
        signerEmail: 'signer@example.test',
        sentById: sentBy.membershipId,
        sentByName: 'Someone',
        sentAt: new Date(sentAt),
        status,
      },
    });
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const owner = await register('admin', 'Performance Test Company');
    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: owner.userId },
    });
    organizationId = membership.organizationId;
    admin = { token: owner.token, membershipId: membership.id };
    for (const key of [MODULES.CRM, MODULES.SCHEDULING, MODULES.CONTRACTS]) {
      const enabled = await request('POST', `/api/v1/modules/${key}`, admin.token);
      expect(enabled.statusCode, enabled.body).toBeLessThan(300);
    }

    downtownId = await location('Downtown');
    northsideId = await location('Northside');

    downtownManager = await addPerson('dtmanager', SYSTEM_ROLE_IDS.location_manager, [downtownId]);
    northManager = await addPerson('northmanager', SYSTEM_ROLE_IDS.location_manager, [northsideId]);
    tech = await addPerson('tech', SYSTEM_ROLE_IDS.employee, [downtownId, northsideId]);
    bystander = await addPerson('bystander', SYSTEM_ROLE_IDS.employee, [downtownId]);

    // Jobs: two at Downtown in August (one ran over), one at Northside in
    // August, and one at Downtown in July.
    await completedJob(
      downtownId,
      [tech.membershipId],
      '2026-08-10T16:00:00Z',
      '2026-08-10T15:50:00Z',
    );
    await completedJob(
      downtownId,
      [tech.membershipId, bystander.membershipId],
      '2026-08-11T16:00:00Z',
      '2026-08-11T17:30:00Z',
    );
    await completedJob(
      northsideId,
      [tech.membershipId],
      '2026-08-12T16:00:00Z',
      '2026-08-12T15:00:00Z',
    );
    await completedJob(
      downtownId,
      [tech.membershipId],
      '2026-07-20T16:00:00Z',
      '2026-07-20T15:00:00Z',
    );
    // 11pm on July 31st in New York is August 1st in UTC: July's, not August's.
    await completedJob(
      downtownId,
      [bystander.membershipId],
      '2026-08-01T03:30:00Z',
      '2026-08-01T03:00:00Z',
    );

    // Contracts: at Downtown, the tech sent three in August — one signed, one
    // waiting, one withdrawn — and one at Northside, signed.
    await contract(downtownId, tech, '2026-08-05T15:00:00Z', 'SIGNED');
    await contract(downtownId, tech, '2026-08-06T15:00:00Z', 'SENT');
    await contract(downtownId, tech, '2026-08-07T15:00:00Z', 'VOIDED');
    await contract(northsideId, tech, '2026-08-08T15:00:00Z', 'SIGNED');

    // Leads: the tech won one at Downtown in August, and has two still open
    // there and one at Northside.
    await customer(downtownId, {
      ownerMembershipId: tech.membershipId,
      stage: 'ACTIVE',
      convertedAt: new Date('2026-08-15T15:00:00Z'),
    });
    await customer(downtownId, { ownerMembershipId: tech.membershipId, stage: 'LEAD' });
    await customer(downtownId, { ownerMembershipId: tech.membershipId, stage: 'LEAD' });
    await customer(northsideId, { ownerMembershipId: tech.membershipId, stage: 'LEAD' });

    // Tasks: the bystander finished two at Downtown, one after it was due.
    for (const [due, done] of [
      ['2026-08-20T20:00:00Z', '2026-08-20T15:00:00Z'],
      ['2026-08-20T20:00:00Z', '2026-08-22T15:00:00Z'],
    ]) {
      await privileged.task.create({
        data: {
          organizationId,
          locationId: downtownId,
          title: 'Call back',
          assigneeMembershipId: bystander.membershipId,
          status: 'DONE',
          dueAt: new Date(due!),
          completedAt: new Date(done!),
        },
      });
    }

    otherToken = (await register('other', 'Performance Test Competitor')).token;
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  it('gives an owner everyone, counting work everywhere', async () => {
    const view = await team(admin.token);
    expect(view.scope.organizationWide).toBe(true);
    expect(statsOf(view.people, tech)).toMatchObject({
      jobs: { count: 3, detail: 1 },
      contracts: { count: 2, detail: 3 },
      leads: { count: 1, detail: 3 },
      tasks: { count: 0, detail: 0 },
    });
    expect(statsOf(view.people, bystander)).toMatchObject({
      jobs: { count: 1, detail: 1 },
      tasks: { count: 2, detail: 1 },
    });
    // Everyone is listed, including people with nothing to show.
    expect(statsOf(view.people, northManager)).toMatchObject({ jobs: { count: 0 } });
  });

  it('gives a branch manager their branch, and only the work done there', async () => {
    const view = await team(downtownManager.token);
    expect(view.scope).toEqual({
      organizationWide: false,
      locations: [expect.objectContaining({ name: 'Downtown' })],
    });
    expect(statsOf(view.people, tech)).toMatchObject({
      jobs: { count: 2, detail: 1 },
      contracts: { count: 1, detail: 2 },
      leads: { count: 1, detail: 2 },
    });
    // Nobody from another branch who did no work here.
    expect(statsOf(view.people, northManager)).toBeUndefined();
    expect(statsOf(view.people, admin)).toBeUndefined();
  });

  it('refuses a branch the manager does not hold as not found', async () => {
    const response = await request(
      'GET',
      `/api/v1/performance?${AUGUST}&locationId=${northsideId}`,
      downtownManager.token,
    );
    expect(response.statusCode).toBe(404);
  });

  it('refuses the team view to an employee', async () => {
    const response = await request('GET', `/api/v1/performance?${AUGUST}`, bystander.token);
    expect(response.statusCode).toBe(403);
  });

  it('gives each person their own numbers from all their work, and nobody else’s', async () => {
    const response = await request('GET', `/api/v1/performance/me?${AUGUST}`, tech.token);
    expect(response.statusCode, response.body).toBe(200);
    const mine = json(response);
    expect(mine.stats).toMatchObject({
      jobs: { count: 3, detail: 1 },
      contracts: { count: 2, detail: 3 },
      leads: { count: 1, detail: 3 },
      tasks: { count: 0, detail: 0 },
    });
    expect(mine).not.toHaveProperty('people');
  });

  it('counts only the period asked for, in the branch’s own zone', async () => {
    const july = await team(admin.token, 'from=2026-07-01&to=2026-07-31');
    expect(statsOf(july.people, tech)).toMatchObject({ jobs: { count: 1 } });
    // Finished at 11pm New York time on July 31st.
    expect(statsOf(july.people, bystander)).toMatchObject({ jobs: { count: 1 } });
  });

  it('refuses a period that ends before it starts', async () => {
    const response = await request(
      'GET',
      '/api/v1/performance?from=2026-08-31&to=2026-08-01',
      admin.token,
    );
    expect(response.statusCode).toBe(400);
  });

  it('names the best in each measure, and nobody for a measure no one scored', async () => {
    const view = await team(admin.token);
    expect(view.standouts).toEqual(
      expect.arrayContaining([
        { measure: 'jobs', names: ['tech'], count: 3 },
        { measure: 'tasks', names: ['bystander'], count: 2 },
      ]),
    );
    const july = await team(admin.token, 'from=2026-07-01&to=2026-07-31');
    expect(july.standouts.find((standout) => standout.measure === 'contracts')).toBeUndefined();
  });

  it('offers a measure only when the business has its module', async () => {
    const view = await team(admin.token);
    expect(view.measures).toEqual(['jobs', 'contracts', 'leads', 'tasks']);

    const off = await request('DELETE', `/api/v1/modules/${MODULES.CONTRACTS}`, admin.token);
    expect(off.statusCode, off.body).toBeLessThan(300);
    try {
      const without = await team(admin.token);
      expect(without.measures).not.toContain('contracts');
      expect(statsOf(without.people, tech)).not.toHaveProperty('contracts');
    } finally {
      await request('POST', `/api/v1/modules/${MODULES.CONTRACTS}`, admin.token);
    }
  });

  it('shows another business none of these people', async () => {
    const view = await team(otherToken);
    for (const actor of [admin, downtownManager, tech, bystander]) {
      expect(statsOf(view.people, actor)).toBeUndefined();
    }
  });
});
