import 'reflect-metadata';

process.env.RATE_LIMIT_ENABLED = 'false';
// The dispatcher runs on demand here, so each test decides when mail goes out.
process.env.DISPATCH_INTERVAL_SECONDS = '0';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DispatcherService } from '../src/notifications/dispatcher.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * The manager's board and "Need a manager".
 *
 *   - a manager sees their branch's day, and nothing of another branch's
 *   - where someone is comes from the job they marked "On site"
 *   - a call reaches the branch's managers, or the owners when it has none
 *   - only the crew can call, and only a branch manager can answer
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

describe('Manager board (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  let dispatcher: DispatcherService;

  let organizationId: string;
  let admin: Actor;
  let downtownManager: Actor;
  let northManager: Actor;
  let tech: Actor;
  let bystander: Actor;

  let downtownId: string;
  let northsideId: string;
  let eastgateId: string;

  let otherToken: string;

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

  /**
   * Jobs on one fixed, past day, and the board asked for that day: whatever
   * hour the suite runs, nothing slips into tomorrow. A day in the past also
   * makes a job that was never started late, which the tests rely on.
   */
  const DAY = '2026-09-07';
  let offset = 0;
  async function bookNow(locationId: string, crew: string[], minutesFromNoon = 0): Promise<string> {
    offset += 1;
    const start = new Date(Date.parse(`${DAY}T16:00:00.000Z`) + minutesFromNoon * 60_000);
    const response = await request('POST', '/api/v1/jobs', admin.token, {
      title: `Visit ${offset}`,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
      locationId,
      assigneeMembershipIds: crew,
      acknowledgeConflicts: true,
    });
    expect(response.statusCode, response.body).toBe(201);
    return json(response).job.id;
  }

  const inbox = async (token: string) =>
    json(await request('GET', '/api/v1/notifications', token)).notifications as Array<{
      title: string;
      linkPath: string;
    }>;

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-board-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Board Test%'");
  }

  async function register(slug: string, organizationName: string) {
    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email: `e2e-board-${slug}@example.test`,
      password: PASSWORD,
      organizationName,
      firstName: slug,
    });
    return { token: tokenOf(response), userId: json(response).user.id as string };
  }

  async function addPerson(slug: string, roleId: string, locationIds: string[]): Promise<Actor> {
    const { userId } = await register(slug, `Board Test Throwaway ${slug}`);
    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `Board Test Throwaway ${slug}` } });
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
      email: `e2e-board-${slug}@example.test`,
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

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    dispatcher = app.get(DispatcherService);
    await cleanUp();

    const owner = await register('admin', 'Board Test Company');
    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: owner.userId },
    });
    organizationId = membership.organizationId;
    admin = { token: owner.token, membershipId: membership.id };
    await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, admin.token);

    downtownId = await location('Downtown');
    northsideId = await location('Northside');
    eastgateId = await location('Eastgate');

    downtownManager = await addPerson('dtmanager', SYSTEM_ROLE_IDS.location_manager, [downtownId]);
    northManager = await addPerson('northmanager', SYSTEM_ROLE_IDS.location_manager, [northsideId]);
    tech = await addPerson('tech', SYSTEM_ROLE_IDS.employee, [downtownId, eastgateId]);
    bystander = await addPerson('bystander', SYSTEM_ROLE_IDS.employee, [downtownId]);

    otherToken = (await register('other', 'Board Test Competitor')).token;
    await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, otherToken);
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('the board', () => {
    it('shows who is on site, from the job they marked', async () => {
      const job = await bookNow(downtownId, [tech.membershipId], -10);
      const onSite = await request('PATCH', `/api/v1/jobs/${job}`, tech.token, {
        status: 'IN_PROGRESS',
      });
      expect(onSite.statusCode, onSite.body).toBe(200);

      const board = json(
        await request(
          'GET',
          `/api/v1/board?day=${DAY}&locationId=${downtownId}`,
          downtownManager.token,
        ),
      );
      const person = board.people.find(
        (p: { membershipId: string }) => p.membershipId === tech.membershipId,
      );
      expect(person).toMatchObject({ state: 'ON_SITE' });
      expect(person.current.id).toBe(job);
    });

    it('lists the jobs nobody is on, and the ones running late', async () => {
      const lonely = await bookNow(downtownId, [], 60);
      const late = await bookNow(downtownId, [bystander.membershipId], -20);

      const board = json(
        await request('GET', `/api/v1/board?day=${DAY}&locationId=${downtownId}`, admin.token),
      );
      expect(board.unassigned.map((j: { id: string }) => j.id)).toContain(lonely);
      expect(board.late.map((j: { id: string }) => j.id)).toContain(late);
    });

    it('shows a manager only their own branch', async () => {
      const northJob = await bookNow(northsideId, [], 30);

      const board = json(await request('GET', `/api/v1/board?day=${DAY}`, downtownManager.token));
      expect(board.locations.map((l: { name: string }) => l.name)).toEqual(['Downtown']);
      expect(board.unassigned.map((j: { id: string }) => j.id)).not.toContain(northJob);

      const asked = await request(
        'GET',
        `/api/v1/board?day=${DAY}&locationId=${northsideId}`,
        downtownManager.token,
      );
      expect(asked.statusCode).toBe(404);
    });

    it('is not for employees', async () => {
      expect((await request('GET', '/api/v1/board', tech.token)).statusCode).toBe(403);
    });
  });

  // =========================================================================

  describe('"Need a manager"', () => {
    it('reaches the branch’s manager, and no other branch’s', async () => {
      const job = await bookNow(downtownId, [tech.membershipId]);
      const called = await request('POST', `/api/v1/jobs/${job}/help`, tech.token, {
        note: 'Customer wants a price for extra rooms',
      });
      expect(called.statusCode, called.body).toBe(201);
      await dispatcher.drain();

      const theirs = await inbox(downtownManager.token);
      expect(
        theirs.some((n) => n.title.includes('needs a manager') && n.linkPath === `/jobs/${job}`),
      ).toBe(true);
      expect(
        (await inbox(northManager.token)).some((n) => n.title.includes('needs a manager')),
      ).toBe(false);
    });

    it('falls back to the owners when the branch has no manager', async () => {
      const job = await bookNow(eastgateId, [tech.membershipId]);
      const before = (await inbox(admin.token)).length;
      await request('POST', `/api/v1/jobs/${job}/help`, tech.token, {});
      await dispatcher.drain();

      const after = await inbox(admin.token);
      expect(after.length).toBe(before + 1);
      expect(after[0]!.title).toContain('needs a manager');
    });

    it('lets only the crew call, and only once at a time', async () => {
      const job = await bookNow(downtownId, [tech.membershipId]);
      expect(
        (await request('POST', `/api/v1/jobs/${job}/help`, bystander.token, {})).statusCode,
      ).toBe(403);
      expect((await request('POST', `/api/v1/jobs/${job}/help`, tech.token, {})).statusCode).toBe(
        201,
      );
      expect((await request('POST', `/api/v1/jobs/${job}/help`, tech.token, {})).statusCode).toBe(
        409,
      );
    });

    it('lets the branch manager answer, tells the caller, and shows it on the board', async () => {
      const job = await bookNow(downtownId, [tech.membershipId]);
      const call = json(await request('POST', `/api/v1/jobs/${job}/help`, tech.token, {}));

      const board = json(
        await request(
          'GET',
          `/api/v1/board?day=${DAY}&locationId=${downtownId}`,
          downtownManager.token,
        ),
      );
      expect(board.help.map((h: { id: string }) => h.id)).toContain(call.id);

      // Another branch's manager cannot even see it.
      expect(
        (await request('POST', `/api/v1/help-requests/${call.id}/acknowledge`, northManager.token))
          .statusCode,
      ).toBe(404);
      // A crewmate is not a manager.
      expect(
        (await request('POST', `/api/v1/help-requests/${call.id}/acknowledge`, tech.token))
          .statusCode,
      ).toBe(403);

      const answered = await request(
        'POST',
        `/api/v1/help-requests/${call.id}/acknowledge`,
        downtownManager.token,
      );
      expect(answered.statusCode, answered.body).toBe(201);
      expect(json(answered)).toMatchObject({ status: 'ACKNOWLEDGED' });

      await dispatcher.drain();
      expect((await inbox(tech.token)).some((n) => n.title.includes('is on it'))).toBe(true);

      const closed = await request('POST', `/api/v1/help-requests/${call.id}/resolve`, tech.token);
      expect(json(closed)).toMatchObject({ status: 'RESOLVED' });
      // A new call can be made once the last is closed.
      expect((await request('POST', `/api/v1/jobs/${job}/help`, tech.token, {})).statusCode).toBe(
        201,
      );
    });

    it('does not let a manager from another branch answer, even one on the crew', async () => {
      // On the crew, so the job and its call are visible to them, and a
      // manager somewhere, so the route lets them in: only the branch rule
      // stands between them and answering for Downtown.
      const job = await bookNow(downtownId, [tech.membershipId, northManager.membershipId]);
      const call = json(await request('POST', `/api/v1/jobs/${job}/help`, tech.token, {}));

      const response = await request(
        'POST',
        `/api/v1/help-requests/${call.id}/acknowledge`,
        northManager.token,
      );
      expect(response.statusCode).toBe(403);
    });

    it('never lets another business see or answer a call', async () => {
      const job = await bookNow(downtownId, [tech.membershipId]);
      const call = json(await request('POST', `/api/v1/jobs/${job}/help`, tech.token, {}));

      expect((await request('GET', `/api/v1/jobs/${job}/help`, otherToken)).statusCode).toBe(404);
      expect(
        (await request('POST', `/api/v1/help-requests/${call.id}/acknowledge`, otherToken))
          .statusCode,
      ).toBe(404);
    });
  });
});
