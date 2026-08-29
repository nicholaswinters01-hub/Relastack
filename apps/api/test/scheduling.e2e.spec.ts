import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Scheduling.
 *
 * The parts that carry the phase:
 *
 *   - conflicts WARN and can be overridden, and touching windows do not clash
 *   - a job never reveals a customer the reader may not see
 *   - whoever is on the job can complete it, and change nothing else
 */

const PASSWORD = 'a-sufficiently-long-password';

/** A fixed Monday, so nothing depends on when the suite runs. */
const DAY = '2026-09-07';
const at = (time: string) => `${DAY}T${time}:00.000Z`;

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

interface Actor {
  token: string;
  membershipId: string;
}

describe('Scheduling (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let organizationId: string;
  let admin: Actor;
  let manager: Actor;
  let crew: Actor;

  let downtownId: string;
  let northsideId: string;
  let northsideCustomerId: string;

  let otherToken: string;
  let otherJobId: string;

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
  const titles = (r: InjectResult): string[] => json(r).jobs.map((j: { title: string }) => j.title);

  const book = (token: string, body: Record<string, unknown>) =>
    request('POST', '/api/v1/jobs', token, body);

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-sched-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Sched Test%'");
  }

  async function addPerson(
    slug: string,
    roleId: string,
    scope: 'ORGANIZATION' | 'LOCATION',
    locationIds: string[] = [],
  ): Promise<Actor> {
    const email = `e2e-sched-${slug}@example.test`;

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName: `Sched Test Throwaway ${slug}`,
    });
    const userId = json(registration).user.id;

    await privileged.organizationMembership.deleteMany({ where: { userId } });
    await privileged.organization.deleteMany({ where: { name: `Sched Test Throwaway ${slug}` } });

    const membership = await privileged.organizationMembership.create({
      data: { userId, organizationId, role: 'MEMBER' },
    });

    const assignment = await privileged.membershipRole.create({
      data: { membershipId: membership.id, roleId, scope, organizationId },
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
      email: 'e2e-sched-admin@example.test',
      password: PASSWORD,
      organizationName: 'Sched Test Company',
    });
    const adminToken = registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const adminMembership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(registration).user.id },
    });
    organizationId = adminMembership.organizationId;
    admin = { token: adminToken, membershipId: adminMembership.id };

    // Scheduling depends on CRM, so enabling it turns both on.
    const enabled = await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, adminToken);
    expect(enabled.statusCode, enabled.body).toBe(200);

    const downtown = await request('POST', '/api/v1/locations', adminToken, {
      name: 'Downtown',
      timezone: 'America/New_York',
    });
    const northside = await request('POST', '/api/v1/locations', adminToken, {
      name: 'Northside',
      timezone: 'America/New_York',
    });
    downtownId = json(downtown).location.id;
    northsideId = json(northside).location.id;

    manager = await addPerson('manager', SYSTEM_ROLE_IDS.location_manager, 'LOCATION', [
      downtownId,
    ]);
    crew = await addPerson('crew', SYSTEM_ROLE_IDS.employee, 'LOCATION', [downtownId]);

    northsideCustomerId = (
      await privileged.customer.create({
        data: {
          organizationId,
          displayName: 'Northside Nils',
          type: 'PERSON',
          stage: 'ACTIVE',
          locationId: northsideId,
        },
        select: { id: true },
      })
    ).id;

    const other = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-sched-other@example.test',
      password: PASSWORD,
      organizationName: 'Sched Test Competitor',
    });
    otherToken = other.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, otherToken);
    otherJobId = json(
      await book(otherToken, {
        title: 'Competitor work',
        startsAt: at('09:00'),
        endsAt: at('10:00'),
      }),
    ).job.id;
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('module gating', () => {
    it('refuses the schedule when Scheduling is off', async () => {
      const off = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-sched-nomodule@example.test',
        password: PASSWORD,
        organizationName: 'Sched Test No Module',
      });
      const token = off.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      const response = await request('GET', '/api/v1/jobs', token);

      expect(response.statusCode).toBe(403);
      expect(json(response).code).toBe('MODULE_NOT_ENABLED');
    });
  });

  // =========================================================================

  describe('tenant isolation', () => {
    it('never lists another organization job', async () => {
      expect(titles(await request('GET', '/api/v1/jobs', admin.token))).not.toContain(
        'Competitor work',
      );
    });

    it('reports one as not found, never forbidden', async () => {
      expect((await request('GET', `/api/v1/jobs/${otherJobId}`, admin.token)).statusCode).toBe(
        404,
      );
    });

    it('refuses to book a job for another organization customer', async () => {
      const theirOrg = await privileged.organization.findFirstOrThrow({
        where: { name: 'Sched Test Competitor' },
      });
      const theirCustomer = await privileged.customer.create({
        data: { organizationId: theirOrg.id, displayName: 'Their Client', type: 'PERSON' },
        select: { id: true },
      });

      const response = await book(admin.token, {
        title: 'Cross-tenant attempt',
        startsAt: at('09:00'),
        endsAt: at('10:00'),
        customerId: theirCustomer.id,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // =========================================================================

  describe('conflicts', () => {
    it('warns rather than refusing outright', async () => {
      const first = await book(admin.token, {
        title: 'Morning hedge',
        startsAt: at('09:00'),
        endsAt: at('11:00'),
        locationId: downtownId,
        assigneeMembershipIds: [crew.membershipId],
      });
      expect(first.statusCode, first.body).toBe(201);

      const clash = await book(admin.token, {
        title: 'Overlapping mow',
        startsAt: at('10:00'),
        endsAt: at('12:00'),
        locationId: downtownId,
        assigneeMembershipIds: [crew.membershipId],
      });

      expect(clash.statusCode).toBe(409);
      expect(json(clash).code).toBe('SCHEDULE_CONFLICT');
      // Named, so the interface can say who and offer a choice rather than
      // just refusing.
      expect(json(clash).conflicts[0].jobTitle).toBe('Morning hedge');
      expect(json(clash).conflicts[0].membershipId).toBe(crew.membershipId);
    });

    it('books anyway once acknowledged', async () => {
      const response = await book(admin.token, {
        title: 'Deliberate overlap',
        startsAt: at('10:00'),
        endsAt: at('12:00'),
        locationId: downtownId,
        assigneeMembershipIds: [crew.membershipId],
        acknowledgeConflicts: true,
      });

      // Refusing outright gets worked around by booking the wrong slot, which
      // is worse than the overlap it prevented.
      expect(response.statusCode, response.body).toBe(201);
    });

    it('does NOT clash on touching windows', async () => {
      const response = await book(admin.token, {
        title: 'Straight after the morning hedge',
        startsAt: at('11:00'),
        endsAt: at('12:30'),
        locationId: downtownId,
        assigneeMembershipIds: [manager.membershipId],
      });
      expect(response.statusCode, response.body).toBe(201);

      const backToBack = await book(admin.token, {
        title: 'And the one after that',
        startsAt: at('12:30'),
        endsAt: at('13:30'),
        locationId: downtownId,
        assigneeMembershipIds: [manager.membershipId],
      });

      // Back-to-back is how a day is filled. Warning on it would train people
      // to ignore the warning.
      expect(backToBack.statusCode, backToBack.body).toBe(201);
    });

    it('ignores a cancelled job — the slot is free again', async () => {
      const booked = await book(admin.token, {
        title: 'Will be cancelled',
        startsAt: at('15:00'),
        endsAt: at('16:00'),
        locationId: downtownId,
        assigneeMembershipIds: [crew.membershipId],
        acknowledgeConflicts: true,
      });
      const id = json(booked).job.id;

      await request('PATCH', `/api/v1/jobs/${id}`, admin.token, { status: 'CANCELLED' });

      const reuse = await book(admin.token, {
        title: 'Takes the freed slot',
        startsAt: at('15:00'),
        endsAt: at('16:00'),
        locationId: downtownId,
        assigneeMembershipIds: [crew.membershipId],
      });

      expect(reuse.statusCode, reuse.body).toBe(201);
    });

    it('still clashes with a COMPLETED job', async () => {
      const booked = await book(admin.token, {
        title: 'Already done',
        startsAt: at('18:00'),
        endsAt: at('19:00'),
        locationId: downtownId,
        assigneeMembershipIds: [manager.membershipId],
      });
      await request('PATCH', `/api/v1/jobs/${json(booked).job.id}`, admin.token, {
        status: 'COMPLETED',
      });

      const clash = await book(admin.token, {
        title: 'Cannot have been in two places',
        startsAt: at('18:30'),
        endsAt: at('19:30'),
        locationId: downtownId,
        assigneeMembershipIds: [manager.membershipId],
      });

      // It happened. A clash with it is a real double-booking in the record.
      expect(clash.statusCode).toBe(409);
    });

    it('does not warn when a job is merely marked complete', async () => {
      const booked = await book(admin.token, {
        title: 'Completing should not warn',
        startsAt: at('20:00'),
        endsAt: at('21:00'),
        locationId: downtownId,
        assigneeMembershipIds: [crew.membershipId],
        acknowledgeConflicts: true,
      });

      const response = await request('PATCH', `/api/v1/jobs/${json(booked).job.id}`, admin.token, {
        status: 'COMPLETED',
      });

      // Neither the window nor the crew moved, so there is no new clash to
      // report and warning would be noise.
      expect(response.statusCode, response.body).toBe(200);
    });

    it('does not count the job against itself when rescheduling', async () => {
      const booked = await book(admin.token, {
        title: 'Moving this one',
        startsAt: at('06:00'),
        endsAt: at('07:00'),
        locationId: downtownId,
        assigneeMembershipIds: [manager.membershipId],
      });

      const moved = await request('PATCH', `/api/v1/jobs/${json(booked).job.id}`, admin.token, {
        startsAt: at('06:30'),
        endsAt: at('07:30'),
      });

      // Overlapping its own old window is not a conflict.
      expect(moved.statusCode, moved.body).toBe(200);
    });
  });

  // =========================================================================

  describe('the customer a job is for', () => {
    let jobId: string;

    beforeAll(async () => {
      jobId = json(
        await book(admin.token, {
          title: 'Job for a Northside customer',
          startsAt: at('13:00'),
          endsAt: at('14:00'),
          locationId: downtownId,
          customerId: northsideCustomerId,
          assigneeMembershipIds: [crew.membershipId],
          acknowledgeConflicts: true,
        }),
      ).job.id;
    });

    it('shows the customer to someone allowed to see them', async () => {
      const response = await request('GET', `/api/v1/jobs/${jobId}`, admin.token);

      expect(json(response).job.customerName).toBe('Northside Nils');
    });

    it('HIDES the customer from the crew member on the job', async () => {
      const response = await request('GET', `/api/v1/jobs/${jobId}`, crew.token);

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).job.title).toBe('Job for a Northside customer');
      // Being sent to a job says nothing about being allowed to know whose.
      expect(json(response).job.customerName).toBeNull();
      expect(json(response).job.customerId).toBeNull();
    });
  });

  // =========================================================================

  describe('visibility', () => {
    it('a scoped role sees only their branch', async () => {
      await book(admin.token, {
        title: 'Northside only',
        startsAt: at('08:00'),
        endsAt: at('08:30'),
        locationId: northsideId,
      });

      expect(titles(await request('GET', '/api/v1/jobs?limit=200', manager.token))).not.toContain(
        'Northside only',
      );
    });

    it('BUT a job you are booked onto is visible wherever it sits', async () => {
      await book(admin.token, {
        title: 'Covering Northside',
        startsAt: at('08:30'),
        endsAt: at('09:30'),
        locationId: northsideId,
        assigneeMembershipIds: [manager.membershipId],
        acknowledgeConflicts: true,
      });

      expect(titles(await request('GET', '/api/v1/jobs?limit=200', manager.token))).toContain(
        'Covering Northside',
      );
    });

    it('and that does not widen sight of the branch', async () => {
      expect(titles(await request('GET', '/api/v1/jobs?limit=200', manager.token))).not.toContain(
        'Northside only',
      );
    });
  });

  // =========================================================================

  describe('who may change what', () => {
    it('an employee cannot book a job', async () => {
      const response = await book(crew.token, {
        title: 'Should not exist',
        startsAt: at('22:00'),
        endsAt: at('23:00'),
        locationId: downtownId,
      });

      expect(response.statusCode).toBe(403);
    });

    it('BUT the crew on a job can complete it', async () => {
      const booked = await book(admin.token, {
        title: 'Crew completes this',
        startsAt: at('05:00'),
        endsAt: at('05:30'),
        locationId: downtownId,
        assigneeMembershipIds: [crew.membershipId],
        acknowledgeConflicts: true,
      });

      const response = await request('PATCH', `/api/v1/jobs/${json(booked).job.id}`, crew.token, {
        status: 'COMPLETED',
      });

      // A crew that cannot mark a visit done from the van stops using the
      // software.
      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).job.status).toBe('COMPLETED');
      expect(json(response).job.completedAt).not.toBeNull();
    });

    it('and can change the status and NOTHING else', async () => {
      const booked = await book(admin.token, {
        title: 'Original title',
        startsAt: at('04:00'),
        endsAt: at('04:30'),
        locationId: downtownId,
        assigneeMembershipIds: [crew.membershipId],
        acknowledgeConflicts: true,
      });
      const id = json(booked).job.id;

      const response = await request('PATCH', `/api/v1/jobs/${id}`, crew.token, {
        status: 'COMPLETED',
        title: 'Renamed by the crew',
      });

      expect(response.statusCode).toBe(403);

      const untouched = await privileged.job.findUniqueOrThrow({ where: { id } });
      expect(untouched.title).toBe('Original title');
      expect(untouched.status).toBe('SCHEDULED');
    });

    it('a manager may not book into a branch they do not run', async () => {
      const response = await book(manager.token, {
        title: 'Not their branch',
        startsAt: at('03:00'),
        endsAt: at('03:30'),
        locationId: northsideId,
      });

      expect(response.statusCode).toBe(403);
    });

    it('deleting needs more than write', async () => {
      const booked = await book(admin.token, {
        title: 'Doomed job',
        startsAt: at('02:00'),
        endsAt: at('02:30'),
        locationId: downtownId,
      });
      const id = json(booked).job.id;

      expect((await request('DELETE', `/api/v1/jobs/${id}`, manager.token)).statusCode).toBe(403);
      expect((await request('DELETE', `/api/v1/jobs/${id}`, admin.token)).statusCode).toBe(204);
    });
  });

  // =========================================================================

  describe('the window itself', () => {
    it('refuses an end before the start', async () => {
      const response = await book(admin.token, {
        title: 'Backwards',
        startsAt: at('14:00'),
        endsAt: at('13:00'),
        locationId: downtownId,
      });

      expect(response.statusCode).toBe(400);
    });

    it('refuses a zero-length job', async () => {
      const response = await book(admin.token, {
        title: 'Instantaneous',
        startsAt: at('14:00'),
        endsAt: at('14:00'),
        locationId: downtownId,
      });

      expect(response.statusCode).toBe(400);
    });

    it('the database refuses it too, not just the schema', async () => {
      // Defence in depth: the CHECK constraint stands whatever calls it.
      await expect(
        privileged.$executeRawUnsafe(
          `INSERT INTO jobs (id, organization_id, title, starts_at, ends_at, created_at, updated_at)
           VALUES (gen_random_uuid(), '${organizationId}', 'Direct insert', '${at('16:00')}', '${at('15:00')}', now(), now())`,
        ),
      ).rejects.toThrow();
    });

    it('carries the branch timezone so the time can be rendered locally', async () => {
      const booked = await book(admin.token, {
        title: 'Timezone check',
        startsAt: at('01:00'),
        endsAt: at('01:30'),
        locationId: downtownId,
      });

      // Stored as an instant, rendered in the branch's zone — which is why
      // Location has carried a timezone since Phase 3.
      expect(json(booked).job.locationTimezone).toBe('America/New_York');
      expect(json(booked).job.startsAt).toBe(at('01:00'));
    });
  });

  // =========================================================================

  describe('finding work', () => {
    it('filters to a calendar window', async () => {
      const response = await request(
        'GET',
        `/api/v1/jobs?from=${at('09:00')}&to=${at('12:00')}&limit=200`,
        admin.token,
      );

      for (const job of json(response).jobs) {
        expect(new Date(job.startsAt).getTime()).toBeGreaterThanOrEqual(
          new Date(at('09:00')).getTime(),
        );
        expect(new Date(job.startsAt).getTime()).toBeLessThan(new Date(at('12:00')).getTime());
      }
    });

    it('finds what is on my own schedule', async () => {
      const response = await request('GET', '/api/v1/jobs?mine=true&limit=200', crew.token);

      for (const job of json(response).jobs) {
        expect(job.assignees.map((a: { membershipId: string }) => a.membershipId)).toContain(
          crew.membershipId,
        );
      }
      expect(json(response).jobs.length).toBeGreaterThan(0);
    });

    it('returns jobs in chronological order', async () => {
      const response = await request('GET', '/api/v1/jobs?limit=200', admin.token);
      const starts = json(response).jobs.map((j: { startsAt: string }) =>
        new Date(j.startsAt).getTime(),
      );

      expect(starts).toEqual([...starts].sort((a, b) => a - b));
    });

    it('a crew of several is returned in full', async () => {
      const booked = await book(admin.token, {
        title: 'Two-person job',
        startsAt: at('23:00'),
        endsAt: at('23:30'),
        locationId: downtownId,
        assigneeMembershipIds: [crew.membershipId, manager.membershipId],
        acknowledgeConflicts: true,
      });

      expect(json(booked).job.assignees).toHaveLength(2);
    });
  });
});
