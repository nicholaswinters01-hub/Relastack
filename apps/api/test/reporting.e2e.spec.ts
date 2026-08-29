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
 * Reporting.
 *
 * The risk here is different from every phase before it: an aggregate is still
 * a disclosure. Telling a branch employee the company has forty customers
 * leaks the size of a book they can see four of, and nothing about a bare
 * number makes that leak visible.
 *
 * So the central assertion is that every count agrees with the list endpoint
 * it summarises, FOR THE SAME READER.
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

describe('Reporting (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let organizationId: string;
  let adminToken: string;
  let managerToken: string;
  let managerMembershipId: string;

  let downtownId: string;
  let northsideId: string;

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
  const dashboard = async (token: string, query = '') =>
    json(await request('GET', `/api/v1/reports/dashboard${query}`, token)).dashboard;

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-report-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Report Test%'");
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-report-admin@example.test',
      password: PASSWORD,
      organizationName: 'Report Test Company',
    });
    adminToken = registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const adminMembership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(registration).user.id },
    });
    organizationId = adminMembership.organizationId;

    for (const key of [MODULES.CRM, MODULES.SCHEDULING, MODULES.REPORTING]) {
      await request('POST', `/api/v1/modules/${key}`, adminToken);
    }

    const downtown = await request('POST', '/api/v1/locations', adminToken, {
      name: 'Downtown',
      timezone: 'UTC',
    });
    const northside = await request('POST', '/api/v1/locations', adminToken, {
      name: 'Northside',
      timezone: 'UTC',
    });
    downtownId = json(downtown).location.id;
    northsideId = json(northside).location.id;

    // A Location Manager who can only see Downtown.
    const managerReg = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-report-manager@example.test',
      password: PASSWORD,
      organizationName: 'Report Test Throwaway',
    });
    const managerUserId = json(managerReg).user.id;
    await privileged.organizationMembership.deleteMany({ where: { userId: managerUserId } });
    await privileged.organization.deleteMany({ where: { name: 'Report Test Throwaway' } });

    const managerMembership = await privileged.organizationMembership.create({
      data: { userId: managerUserId, organizationId, role: 'MEMBER' },
    });
    managerMembershipId = managerMembership.id;

    const assignment = await privileged.membershipRole.create({
      data: {
        membershipId: managerMembership.id,
        roleId: SYSTEM_ROLE_IDS.location_manager,
        scope: 'LOCATION',
        organizationId,
      },
    });
    await privileged.membershipRoleLocation.create({
      data: { membershipRoleId: assignment.id, locationId: downtownId, organizationId },
    });

    const login = await request('POST', '/api/v1/auth/login', undefined, {
      email: 'e2e-report-manager@example.test',
      password: PASSWORD,
    });
    managerToken = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

    // Three customers at Downtown, five at Northside.
    for (let i = 0; i < 3; i++) {
      await privileged.customer.create({
        data: {
          organizationId,
          displayName: `Downtown ${i}`,
          type: 'PERSON',
          stage: 'ACTIVE',
          locationId: downtownId,
          convertedAt: new Date(),
        },
      });
    }
    for (let i = 0; i < 5; i++) {
      await privileged.customer.create({
        data: {
          organizationId,
          displayName: `Northside ${i}`,
          type: 'PERSON',
          stage: 'LEAD',
          locationId: northsideId,
        },
      });
    }
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('module gating', () => {
    it('refuses the dashboard when Reporting is off', async () => {
      const off = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-report-nomodule@example.test',
        password: PASSWORD,
        organizationName: 'Report Test No Module',
      });
      const token = off.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      const response = await request('GET', '/api/v1/reports/dashboard', token);

      expect(response.statusCode).toBe(403);
      expect(json(response).code).toBe('MODULE_NOT_ENABLED');
    });
  });

  // =========================================================================

  describe('the numbers respect who is asking', () => {
    it('an owner sees the whole company', async () => {
      const report = await dashboard(adminToken);

      expect(report.customers.total).toBe(8);
      expect(report.customers.active).toBe(3);
      expect(report.customers.leads).toBe(5);
      expect(report.scope.organizationWide).toBe(true);
    });

    it('a branch manager sees ONLY their branch', async () => {
      const report = await dashboard(managerToken);

      // The whole risk of the phase. Eight would leak the size of a book they
      // can see three of.
      expect(report.customers.total).toBe(3);
      expect(report.customers.leads).toBe(0);
      expect(report.scope.organizationWide).toBe(false);
      expect(report.scope.locationCount).toBe(1);
    });

    it('and the count agrees with the list endpoint for that same reader', async () => {
      // The assertion that proves the report and the list share a rule rather
      // than merely happening to agree today.
      const report = await dashboard(managerToken);
      const list = await request('GET', '/api/v1/customers?limit=100', managerToken);

      expect(report.customers.total).toBe(json(list).customers.length);
    });

    it('says whose numbers these are, rather than implying a company total', async () => {
      const owner = await dashboard(adminToken);
      const manager = await dashboard(managerToken);

      expect(owner.scope.organizationWide).toBe(true);
      expect(manager.scope.organizationWide).toBe(false);
    });
  });

  // =========================================================================

  describe('tenant isolation', () => {
    it('never counts another organization', async () => {
      const other = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-report-other@example.test',
        password: PASSWORD,
        organizationName: 'Report Test Competitor',
      });
      const otherOrg = await privileged.organization.findFirstOrThrow({
        where: { name: 'Report Test Competitor' },
      });

      for (let i = 0; i < 20; i++) {
        await privileged.customer.create({
          data: {
            organizationId: otherOrg.id,
            displayName: `Competitor client ${i}`,
            type: 'PERSON',
            stage: 'ACTIVE',
          },
        });
      }

      const report = await dashboard(adminToken);
      expect(report.customers.total).toBe(8);

      const otherToken = other.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
      await request('POST', `/api/v1/modules/${MODULES.REPORTING}`, otherToken);
      const theirs = await dashboard(otherToken);

      expect(theirs.customers.total).toBe(20);
    });
  });

  // =========================================================================

  describe('what the numbers mean', () => {
    it('counts open and overdue tasks separately', async () => {
      await request('POST', '/api/v1/tasks', adminToken, {
        title: 'Overdue thing',
        locationId: downtownId,
        dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      });
      await request('POST', '/api/v1/tasks', adminToken, {
        title: 'Not due yet',
        locationId: downtownId,
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

      const report = await dashboard(adminToken);

      expect(report.tasks.open).toBeGreaterThanOrEqual(2);
      expect(report.tasks.overdue).toBeGreaterThanOrEqual(1);
      expect(report.tasks.overdue).toBeLessThan(report.tasks.open);
    });

    it('reports the no-show rate as null when nothing was scheduled', async () => {
      const report = await dashboard(adminToken, '?from=2020-01-01&to=2020-01-07');

      // Not zero. A rate over no visits is unanswerable, and 0% would read as
      // "perfect attendance" rather than "no data".
      expect(report.jobs.noShowRate).toBeNull();
    });

    it('computes a no-show rate from visits that were meant to happen', async () => {
      const today = new Date().toISOString().slice(0, 10);

      const book = (title: string, hour: number) =>
        request('POST', '/api/v1/jobs', adminToken, {
          title,
          startsAt: `${today}T${String(hour).padStart(2, '0')}:00:00.000Z`,
          endsAt: `${today}T${String(hour + 1).padStart(2, '0')}:00:00.000Z`,
          locationId: downtownId,
          acknowledgeConflicts: true,
        });

      const a = json(await book('Went fine', 8)).job.id;
      const b = json(await book('Went fine too', 9)).job.id;
      const c = json(await book('Nobody in', 10)).job.id;
      const d = json(await book('Called ahead', 11)).job.id;

      await request('PATCH', `/api/v1/jobs/${a}`, adminToken, { status: 'COMPLETED' });
      await request('PATCH', `/api/v1/jobs/${b}`, adminToken, { status: 'COMPLETED' });
      await request('PATCH', `/api/v1/jobs/${c}`, adminToken, { status: 'NO_SHOW' });
      await request('PATCH', `/api/v1/jobs/${d}`, adminToken, { status: 'CANCELLED' });

      const report = await dashboard(adminToken, `?from=${today}&to=${today}`);

      // 1 no-show out of 3 attempted. The cancellation is excluded: a visit
      // called off in advance was never a chance to be stood up.
      expect(report.jobs.completedInRange).toBe(2);
      expect(report.jobs.noShowInRange).toBe(1);
      expect(report.jobs.cancelledInRange).toBe(1);
      expect(report.jobs.noShowRate).toBe(33);
    });

    it('includes quiet days in the chart rather than compressing them', async () => {
      const report = await dashboard(adminToken, '?from=2026-06-01&to=2026-06-07');

      // Omitting empty days makes a fortnight of nothing look like steady work.
      expect(report.jobs.completedByDay).toHaveLength(7);
      expect(report.jobs.completedByDay[0]!.day).toBe('2026-06-01');
      expect(report.jobs.completedByDay.every((d: { count: number }) => d.count === 0)).toBe(true);
    });

    it('defaults to a trailing 30 days', async () => {
      const report = await dashboard(adminToken);

      const span = (new Date(report.to).getTime() - new Date(report.from).getTime()) / 86_400_000;

      expect(span).toBe(29);
    });

    it('counts only what the reader may see, for tasks too', async () => {
      await request('POST', '/api/v1/tasks', adminToken, {
        title: 'Northside task',
        locationId: northsideId,
      });

      const owner = await dashboard(adminToken);
      const manager = await dashboard(managerToken);

      expect(manager.tasks.open).toBeLessThan(owner.tasks.open);
      expect(managerMembershipId).toBeTruthy();
    });
  });
});
