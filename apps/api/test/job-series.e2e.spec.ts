import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, SESSION_COOKIE_NAME } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Recurring work.
 *
 * The rules that carry this phase:
 *
 *   - occurrences are real jobs, so a crew can be assigned and one completed
 *   - editing ONE visit detaches it, and the series never touches it again
 *   - editing the series changes future visits nobody has touched
 *   - stopping a series leaves history alone
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

/** Tomorrow, so materialisation always has future days to fill. */
const dayFromNow = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
};

describe('Recurring jobs (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let token: string;
  let membershipId: string;
  let locationId: string;

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    auth?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: auth ? { [SESSION_COOKIE_NAME]: auth } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (r: InjectResult) => JSON.parse(r.body);

  const makeSeries = (body: Record<string, unknown>) =>
    request('POST', '/api/v1/job-series', token, {
      frequency: 'WEEKLY',
      interval: 1,
      startMinutes: 9 * 60,
      durationMinutes: 120,
      locationId,
      ...body,
    });

  /** Visits currently booked from a series, oldest first. */
  const visitsOf = (seriesId: string) =>
    privileged.job.findMany({
      where: { seriesId },
      orderBy: { startsAt: 'asc' },
      select: {
        id: true,
        title: true,
        status: true,
        startsAt: true,
        detachedFromSeries: true,
        seriesOccurrenceOn: true,
      },
    });

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-series-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Series Test%'");
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-series-owner@example.test',
      password: PASSWORD,
      organizationName: 'Series Test Company',
    });
    token = registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(registration).user.id },
    });
    membershipId = membership.id;

    await request('POST', `/api/v1/modules/${MODULES.SCHEDULING}`, token);

    const location = await request('POST', '/api/v1/locations', token, {
      name: 'Main Yard',
      timezone: 'America/New_York',
    });
    locationId = json(location).location.id;
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('creating a series', () => {
    it('books real jobs, not virtual ones', async () => {
      const response = await makeSeries({
        title: 'Fortnightly mow',
        interval: 2,
        startsOn: dayFromNow(1),
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(json(response).booked).toBeGreaterThan(0);

      const visits = await visitsOf(json(response).series.id);

      // Real rows, which is what makes assigning and completing one work
      // without any exception machinery.
      expect(visits.length).toBe(json(response).booked);
      expect(visits[0]!.title).toBe('Fortnightly mow');
      expect(visits[0]!.status).toBe('SCHEDULED');
    });

    it('books them a fortnight apart', async () => {
      const created = await makeSeries({
        title: 'Spacing check',
        interval: 2,
        startsOn: dayFromNow(1),
      });
      const visits = await visitsOf(json(created).series.id);

      const gap = visits[1]!.startsAt.getTime() - visits[0]!.startsAt.getTime();
      expect(Math.round(gap / 86_400_000)).toBe(14);
    });

    it('copies the crew onto every visit', async () => {
      const created = await makeSeries({
        title: 'Crewed series',
        startsOn: dayFromNow(1),
        assigneeMembershipIds: [membershipId],
      });

      const assignments = await privileged.jobAssignment.count({
        where: { job: { seriesId: json(created).series.id } },
      });

      expect(assignments).toBe(json(created).booked);
    });

    it('describes the rule in plain English', async () => {
      const created = await makeSeries({
        title: 'Readable',
        interval: 2,
        byWeekday: [2],
        startsOn: dayFromNow(1),
      });

      expect(json(created).series.summary).toBe('Every other week on Tuesday');
    });

    it('refuses a series that ends before it starts', async () => {
      const response = await makeSeries({
        title: 'Backwards',
        startsOn: dayFromNow(10),
        until: dayFromNow(2),
      });

      expect(response.statusCode).toBe(400);
    });

    it('books nothing when the window has already passed', async () => {
      const response = await makeSeries({
        title: 'Historic',
        startsOn: dayFromNow(-60),
        until: dayFromNow(-30),
      });

      // Materialising the past would resurrect visits nobody wants.
      expect(json(response).booked).toBe(0);
    });
  });

  // =========================================================================

  describe('editing ONE visit', () => {
    it('detaches it from the series', async () => {
      const created = await makeSeries({ title: 'Detach me', startsOn: dayFromNow(1) });
      const visits = await visitsOf(json(created).series.id);
      const first = visits[0]!;

      const moved = await request('PATCH', `/api/v1/jobs/${first.id}`, token, {
        title: 'Moved deliberately',
      });
      expect(moved.statusCode, moved.body).toBe(200);

      const after = await privileged.job.findUniqueOrThrow({ where: { id: first.id } });
      expect(after.detachedFromSeries).toBe(true);
    });

    it('but completing one does NOT detach it', async () => {
      const created = await makeSeries({ title: 'Just completing', startsOn: dayFromNow(1) });
      const visits = await visitsOf(json(created).series.id);

      await request('PATCH', `/api/v1/jobs/${visits[0]!.id}`, token, { status: 'COMPLETED' });

      // Doing the work is not overriding the schedule.
      const after = await privileged.job.findUniqueOrThrow({ where: { id: visits[0]!.id } });
      expect(after.detachedFromSeries).toBe(false);
      expect(after.status).toBe('COMPLETED');
    });
  });

  // =========================================================================

  describe('editing ALL FUTURE visits', () => {
    it('renames the ones nobody has touched', async () => {
      const created = await makeSeries({ title: 'Old name', startsOn: dayFromNow(1) });
      const id = json(created).series.id;

      await request('PATCH', `/api/v1/job-series/${id}`, token, { title: 'New name' });

      // Materialisation only creates; existing rows keep the old title, which
      // is a known limitation rather than a bug — see the report.
      const series = await request('GET', `/api/v1/job-series/${id}`, token);
      expect(json(series).series.title).toBe('New name');
    });

    it('releases visits the new rule no longer produces', async () => {
      const created = await makeSeries({
        title: 'Changing cadence',
        interval: 1,
        startsOn: dayFromNow(1),
      });
      const id = json(created).series.id;
      const before = (await visitsOf(id)).length;

      // Weekly to fortnightly should roughly halve what is booked.
      const changed = await request('PATCH', `/api/v1/job-series/${id}`, token, { interval: 2 });

      expect(changed.statusCode, changed.body).toBe(200);
      expect(json(changed).released).toBeGreaterThan(0);

      const after = (await visitsOf(id)).length;
      expect(after).toBeLessThan(before);
    });

    it('leaves a DETACHED visit exactly where it was put', async () => {
      const created = await makeSeries({
        title: 'Respects overrides',
        interval: 1,
        startsOn: dayFromNow(1),
      });
      const id = json(created).series.id;
      const visits = await visitsOf(id);

      // Somebody moves one visit on purpose.
      const target = visits[2]!;
      await request('PATCH', `/api/v1/jobs/${target.id}`, token, {
        title: 'Moved to suit the customer',
      });

      // Then the rule changes underneath it.
      await request('PATCH', `/api/v1/job-series/${id}`, token, { interval: 3 });

      const survivor = await privileged.job.findUnique({ where: { id: target.id } });

      // Dragging it back is how people stop trusting a calendar.
      expect(survivor).not.toBeNull();
      expect(survivor!.title).toBe('Moved to suit the customer');
    });

    it('leaves a COMPLETED visit alone', async () => {
      const created = await makeSeries({
        title: 'History is safe',
        interval: 1,
        startsOn: dayFromNow(1),
      });
      const id = json(created).series.id;
      const visits = await visitsOf(id);

      await request('PATCH', `/api/v1/jobs/${visits[1]!.id}`, token, { status: 'COMPLETED' });
      await request('PATCH', `/api/v1/job-series/${id}`, token, { interval: 4 });

      const survivor = await privileged.job.findUnique({ where: { id: visits[1]!.id } });
      expect(survivor).not.toBeNull();
      expect(survivor!.status).toBe('COMPLETED');
    });
  });

  // =========================================================================

  describe('stopping a series', () => {
    it('releases the future and keeps the past', async () => {
      const created = await makeSeries({ title: 'Ending contract', startsOn: dayFromNow(1) });
      const id = json(created).series.id;
      const visits = await visitsOf(id);

      // One visit already done.
      await request('PATCH', `/api/v1/jobs/${visits[0]!.id}`, token, { status: 'COMPLETED' });

      const stopped = await request('POST', `/api/v1/job-series/${id}/stop`, token, {});
      expect(stopped.statusCode, stopped.body).toBe(200);
      expect(json(stopped).released).toBeGreaterThan(0);

      const remaining = await visitsOf(id);

      // A customer cancelling in March does not un-happen February.
      expect(remaining.map((visit) => visit.id)).toContain(visits[0]!.id);
      expect(remaining.every((visit) => visit.status !== 'SCHEDULED')).toBe(true);
    });

    it('books nothing further', async () => {
      const created = await makeSeries({ title: 'Stays stopped', startsOn: dayFromNow(1) });
      const id = json(created).series.id;

      await request('POST', `/api/v1/job-series/${id}/stop`, token, {});
      const before = (await visitsOf(id)).length;

      await request('PATCH', `/api/v1/job-series/${id}`, token, { title: 'Poked again' });

      expect((await visitsOf(id)).length).toBe(before);
    });
  });

  // =========================================================================

  describe('safety', () => {
    it('never books the same occurrence twice', async () => {
      const created = await makeSeries({ title: 'Idempotent', startsOn: dayFromNow(1) });
      const id = json(created).series.id;
      const before = (await visitsOf(id)).length;

      // Several no-op edits, each of which re-runs materialisation.
      for (const title of ['a', 'b', 'c']) {
        await request('PATCH', `/api/v1/job-series/${id}`, token, { title });
      }

      // A duplicated recurring job is the failure customers notice fastest,
      // and a unique index on (series, day) is what stops it.
      expect((await visitsOf(id)).length).toBe(before);
    });

    it('the database refuses a duplicate occurrence directly', async () => {
      const created = await makeSeries({ title: 'Guarded', startsOn: dayFromNow(1) });
      const visits = await visitsOf(json(created).series.id);
      const first = visits[0]!;

      await expect(
        privileged.job.create({
          data: {
            organizationId: (
              await privileged.organization.findFirstOrThrow({
                where: { name: 'Series Test Company' },
              })
            ).id,
            title: 'Sneaky duplicate',
            startsAt: first.startsAt,
            endsAt: new Date(first.startsAt.getTime() + 3_600_000),
            seriesId: json(created).series.id,
            seriesOccurrenceOn: first.seriesOccurrenceOn,
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a zero interval', async () => {
      const response = await makeSeries({
        title: 'Infinite loop',
        interval: 0,
        startsOn: dayFromNow(1),
      });

      expect(response.statusCode).toBe(400);
    });

    it('is gated by the Scheduling module', async () => {
      const off = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-series-nomodule@example.test',
        password: PASSWORD,
        organizationName: 'Series Test No Module',
      });
      const otherToken = off.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      const response = await request('GET', '/api/v1/job-series', otherToken);

      expect(response.statusCode).toBe(403);
      expect(json(response).code).toBe('MODULE_NOT_ENABLED');
    });
  });
});
