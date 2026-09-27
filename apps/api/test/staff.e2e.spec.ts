import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';
process.env.DISPATCH_INTERVAL_SECONDS = '0';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@platform/db';
import { SESSION_COOKIE_NAME } from '@platform/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * The staff console.
 *
 * What matters most, in order:
 *   - only staff get in, and customers cannot even tell it exists
 *   - staff see ACCOUNT information and never a business's own customers —
 *     proven against the database, not just the endpoints
 *   - every change says why, and the record of it cannot be altered
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

describe('Staff console (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  let prisma: PrismaService;

  let staffToken: string;
  let staffUserId: string;
  let ownerToken: string;
  let ownerUserId: string;
  let alphaId: string;
  let betaId: string;

  const request = (method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (r: InjectResult) => JSON.parse(r.body);
  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

  async function register(email: string, organizationName: string) {
    const response = await request('POST', '/api/v1/auth/register', undefined, {
      email,
      password: PASSWORD,
      organizationName,
    });
    expect(response.statusCode, response.body).toBe(201);
    const userId = json(response).user.id as string;
    const organizationId = (
      await privileged.organizationMembership.findFirstOrThrow({ where: { userId } })
    ).organizationId;
    return { token: tokenOf(response), userId, organizationId };
  }

  async function login(email: string) {
    return request('POST', '/api/v1/auth/login', undefined, { email, password: PASSWORD });
  }

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM staff_audit_events WHERE staff_email LIKE 'e2e-staff-%@example.test'",
    );
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-staff-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Staff Test%'");
  }

  beforeAll(async () => {
    const created = await createTestApp();
    app = created.app;
    prisma = created.prisma;
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const staff = await register('e2e-staff-agent@example.test', 'Staff Test Home');
    staffToken = staff.token;
    staffUserId = staff.userId;

    // Granted the only way it can be: directly, as the owner role.
    await privileged.platformStaff.create({ data: { userId: staffUserId, note: 'e2e' } });

    const alpha = await register('e2e-staff-owner@example.test', 'Staff Test Alpha');
    ownerToken = alpha.token;
    ownerUserId = alpha.userId;
    alphaId = alpha.organizationId;

    betaId = (await register('e2e-staff-beta@example.test', 'Staff Test Beta')).organizationId;

    await request('POST', '/api/v1/locations', ownerToken, { name: 'Alpha Yard', timezone: 'UTC' });

    // Something a business keeps about its own customers. Staff must never see it.
    await privileged.customer.create({
      data: {
        organizationId: alphaId,
        displayName: 'Private Customer',
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

  describe('who gets in', () => {
    it('lets staff in', async () => {
      const response = await request('GET', '/api/v1/staff/me', staffToken);

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).email).toBe('e2e-staff-agent@example.test');
    });

    it('answers a customer as if the console did not exist', async () => {
      for (const url of [
        '/api/v1/staff/me',
        '/api/v1/staff/overview',
        '/api/v1/staff/businesses',
      ]) {
        expect((await request('GET', url, ownerToken)).statusCode).toBe(404);
      }
      expect(
        (
          await request('POST', `/api/v1/staff/businesses/${alphaId}/notes`, ownerToken, {
            body: 'x',
          })
        ).statusCode,
      ).toBe(404);
    });

    it('requires signing in at all', async () => {
      expect((await request('GET', '/api/v1/staff/me')).statusCode).toBe(401);
    });

    it('takes effect immediately when someone stops being staff', async () => {
      await privileged.platformStaff.delete({ where: { userId: staffUserId } });
      expect((await request('GET', '/api/v1/staff/me', staffToken)).statusCode).toBe(404);

      await privileged.platformStaff.create({ data: { userId: staffUserId } });
      expect((await request('GET', '/api/v1/staff/me', staffToken)).statusCode).toBe(200);
    });
  });

  // =========================================================================

  describe('what the database allows', () => {
    it('shows staff every business', async () => {
      const ids = await prisma.withStaff(staffUserId, (tx) =>
        tx.organization.findMany({ select: { id: true } }),
      );

      expect(ids.map((o) => o.id)).toEqual(expect.arrayContaining([alphaId, betaId]));
    });

    it("never shows staff a business's own customers", async () => {
      // They exist...
      expect(await privileged.customer.count({ where: { organizationId: alphaId } })).toBe(1);

      // ...and the staff hatch cannot reach them, whatever the code asks for.
      const seen = await prisma.withStaff(staffUserId, (tx) =>
        tx.customer.findMany({ where: { organizationId: alphaId } }),
      );
      expect(seen).toHaveLength(0);
    });

    it('grants nothing to someone who is not staff, even with the flag set', async () => {
      const seen = await prisma.withStaff(ownerUserId, (tx) =>
        tx.organization.findMany({ where: { id: betaId } }),
      );

      expect(seen).toHaveLength(0);
    });

    it('does not let anyone make themselves staff', async () => {
      await expect(
        prisma.withUserOnly(ownerUserId, (tx) =>
          tx.platformStaff.create({ data: { userId: ownerUserId } }),
        ),
      ).rejects.toThrow();

      expect(await privileged.platformStaff.count({ where: { userId: ownerUserId } })).toBe(0);
    });

    it('does not let staff delete people from a business', async () => {
      const result = await prisma.withStaff(staffUserId, (tx) =>
        tx.organizationMembership.deleteMany({ where: { organizationId: alphaId } }),
      );

      expect(result.count).toBe(0);
      expect(
        await privileged.organizationMembership.count({ where: { organizationId: alphaId } }),
      ).toBe(1);
    });

    it('does not let the audit trail be edited or erased', async () => {
      await request('GET', `/api/v1/staff/businesses/${alphaId}`, staffToken);

      await expect(
        prisma.withStaff(staffUserId, (tx) => tx.staffAuditEvent.deleteMany({})),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        prisma.withStaff(staffUserId, (tx) =>
          tx.staffAuditEvent.updateMany({ data: { reason: 'rewritten' } }),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('does not let an entry claim to be from someone else', async () => {
      await expect(
        prisma.withStaff(staffUserId, (tx) =>
          tx.staffAuditEvent.create({
            data: {
              staffUserId: ownerUserId,
              staffEmail: 'someone-else@example.test',
              action: 'forged',
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('never shows a business the notes staff keep about it', async () => {
      await request('POST', `/api/v1/staff/businesses/${alphaId}/notes`, staffToken, {
        body: 'Called about invoices',
      });

      const visibleToBusiness = await prisma.withTenant(
        { organizationId: alphaId, userId: ownerUserId },
        (tx) => tx.staffNote.findMany(),
      );
      expect(visibleToBusiness).toHaveLength(0);
    });
  });

  // =========================================================================

  describe('finding a business', () => {
    it('counts businesses on the overview', async () => {
      const response = await request('GET', '/api/v1/staff/overview', staffToken);

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).businesses).toBeGreaterThanOrEqual(3);
      expect(json(response).trialing).toBeGreaterThanOrEqual(3);
    });

    it("searches by any member's email", async () => {
      const response = await request(
        'GET',
        '/api/v1/staff/businesses?search=e2e-staff-owner',
        staffToken,
      );

      expect(response.statusCode, response.body).toBe(200);
      const names = json(response).businesses.map((b: { name: string }) => b.name);
      expect(names).toEqual(['Staff Test Alpha']);
      expect(json(response).businesses[0].ownerEmail).toBe('e2e-staff-owner@example.test');
    });

    it('shows account information, and no customers', async () => {
      const response = await request('GET', `/api/v1/staff/businesses/${alphaId}`, staffToken);

      expect(response.statusCode, response.body).toBe(200);
      const detail = json(response);
      expect(detail.business.name).toBe('Staff Test Alpha');
      expect(detail.members.map((m: { email: string }) => m.email)).toEqual([
        'e2e-staff-owner@example.test',
      ]);
      expect(detail.locations.map((l: { name: string }) => l.name)).toEqual(['Alpha Yard']);
      expect(detail.subscription.effectiveStatus).toBe('TRIALING');
      expect(detail).not.toHaveProperty('customers');
      expect(response.body).not.toContain('Private Customer');
    });

    it('records the look', async () => {
      const looks = await privileged.staffAuditEvent.count({
        where: { organizationId: alphaId, action: 'business.viewed', staffUserId },
      });

      expect(looks).toBeGreaterThan(0);
    });

    it('answers 404 for a business that does not exist', async () => {
      const response = await request(
        'GET',
        '/api/v1/staff/businesses/00000000-0000-4000-8000-000000000000',
        staffToken,
      );

      expect(response.statusCode).toBe(404);
    });
  });

  // =========================================================================

  describe('helping a business', () => {
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

    it('refuses a change with no reason', async () => {
      const response = await request(
        'POST',
        `/api/v1/staff/businesses/${alphaId}/trial`,
        staffToken,
        {
          until: inDays(30),
        },
      );

      expect(response.statusCode).toBe(400);
    });

    it('extends a trial, and says why in the record', async () => {
      const until = inDays(30);
      const response = await request(
        'POST',
        `/api/v1/staff/businesses/${alphaId}/trial`,
        staffToken,
        {
          until,
          reason: 'Needs more time to evaluate',
        },
      );
      expect(response.statusCode, response.body).toBe(204);

      const subscription = await privileged.subscription.findUniqueOrThrow({
        where: { organizationId: alphaId },
      });
      expect(subscription.trialEndsAt?.toISOString()).toBe(until);

      const entry = await privileged.staffAuditEvent.findFirstOrThrow({
        where: { organizationId: alphaId, action: 'trial.extended' },
      });
      expect(entry.reason).toBe('Needs more time to evaluate');
      expect(entry.staffEmail).toBe('e2e-staff-agent@example.test');
    });

    it('restarts a trial that lapsed, giving the business back full access', async () => {
      await privileged.subscription.update({
        where: { organizationId: alphaId },
        data: { status: 'SUSPENDED', trialEndsAt: new Date(Date.now() - 86_400_000) },
      });

      // Read-only while lapsed.
      const blocked = await request('POST', '/api/v1/locations', ownerToken, {
        name: 'Blocked Yard',
        timezone: 'UTC',
      });
      expect(blocked.statusCode).toBe(403);

      await request('POST', `/api/v1/staff/businesses/${alphaId}/trial`, staffToken, {
        until: inDays(14),
        reason: 'Trial lapsed while they were away',
      });

      const allowed = await request('POST', '/api/v1/locations', ownerToken, {
        name: 'Second Yard',
        timezone: 'UTC',
      });
      expect(allowed.statusCode, allowed.body).toBe(201);
    });

    it('refuses a trial end in the past', async () => {
      const response = await request(
        'POST',
        `/api/v1/staff/businesses/${alphaId}/trial`,
        staffToken,
        {
          until: inDays(-1),
          reason: 'Mistyped date',
        },
      );

      expect(response.statusCode).toBe(400);
    });

    it('changes plan without ending the trial', async () => {
      const response = await request(
        'POST',
        `/api/v1/staff/businesses/${alphaId}/plan`,
        staffToken,
        {
          planKey: 'business',
          reason: 'Wants to try every module',
        },
      );
      expect(response.statusCode, response.body).toBe(204);

      const subscription = await privileged.subscription.findUniqueOrThrow({
        where: { organizationId: alphaId },
      });
      expect(subscription.planKey).toBe('business');
      expect(subscription.status).toBe('TRIALING');
    });

    it('refuses a plan the business has outgrown', async () => {
      // Two active locations now; Starter allows one.
      const response = await request(
        'POST',
        `/api/v1/staff/businesses/${alphaId}/plan`,
        staffToken,
        {
          planKey: 'starter',
          reason: 'Asked for a cheaper plan',
        },
      );

      expect(response.statusCode).toBe(400);
      expect(json(response).message).toMatch(/allows 1 location/);
    });

    it('suspends a business completely, and reactivates it', async () => {
      await request('POST', `/api/v1/staff/businesses/${alphaId}/status`, staffToken, {
        status: 'SUSPENDED',
        reason: 'Owner asked to pause the account',
      });
      expect((await request('GET', '/api/v1/locations', ownerToken)).statusCode).toBe(403);

      await request('POST', `/api/v1/staff/businesses/${alphaId}/status`, staffToken, {
        status: 'ACTIVE',
        reason: 'Owner is back',
      });
      expect((await request('GET', '/api/v1/locations', ownerToken)).statusCode).toBe(200);
    });

    it('clears a sign-in lockout', async () => {
      await privileged.user.update({
        where: { id: ownerUserId },
        data: { failedLoginAttempts: 8, lockedUntil: new Date(Date.now() + 15 * 60_000) },
      });
      expect((await login('e2e-staff-owner@example.test')).statusCode).not.toBe(200);

      const response = await request(
        'POST',
        `/api/v1/staff/businesses/${alphaId}/members/${ownerUserId}/unlock`,
        staffToken,
        { reason: 'Locked out before a job' },
      );
      expect(response.statusCode, response.body).toBe(204);

      const again = await login('e2e-staff-owner@example.test');
      expect(again.statusCode, again.body).toBe(200);
      ownerToken = tokenOf(again);
    });

    it('will not act on someone from a different business', async () => {
      const response = await request(
        'POST',
        `/api/v1/staff/businesses/${betaId}/members/${ownerUserId}/unlock`,
        staffToken,
        { reason: 'Wrong business on purpose' },
      );

      expect(response.statusCode).toBe(404);
    });

    it('signs someone out everywhere', async () => {
      expect((await request('GET', '/api/v1/auth/me', ownerToken)).statusCode).toBe(200);

      await request(
        'POST',
        `/api/v1/staff/businesses/${alphaId}/members/${ownerUserId}/sign-out`,
        staffToken,
        { reason: 'Lost their phone' },
      );

      expect((await request('GET', '/api/v1/auth/me', ownerToken)).statusCode).toBe(401);
      ownerToken = tokenOf(await login('e2e-staff-owner@example.test'));
    });

    it('gives a pending invitation a new link, and the old one stops working', async () => {
      const invited = await request('POST', '/api/v1/invitations', ownerToken, {
        email: 'e2e-staff-invitee@example.test',
        roleKey: 'employee',
        scope: 'ORGANIZATION',
        locationIds: [],
      });
      expect(invited.statusCode, invited.body).toBe(201);
      const oldToken = new URL(json(invited).acceptUrl).searchParams.get('token')!;
      const invitationId = json(invited).invitation.id;

      const reissued = await request(
        'POST',
        `/api/v1/staff/businesses/${alphaId}/invitations/${invitationId}/reissue`,
        staffToken,
        { reason: 'Original email never arrived' },
      );
      expect(reissued.statusCode, reissued.body).toBe(201);
      const newToken = new URL(json(reissued).acceptUrl).searchParams.get('token')!;
      expect(newToken).not.toBe(oldToken);

      const withOld = await request('POST', '/api/v1/invitations/accept', undefined, {
        token: oldToken,
        password: PASSWORD,
      });
      expect(withOld.statusCode).not.toBe(200);

      const withNew = await request('POST', '/api/v1/invitations/accept', undefined, {
        token: newToken,
        password: PASSWORD,
      });
      expect(withNew.statusCode, withNew.body).toBe(200);
    });

    it('keeps a full, readable record of what was done and why', async () => {
      const response = await request('GET', '/api/v1/staff/audit', staffToken);
      expect(response.statusCode, response.body).toBe(200);

      const actions = json(response)
        .events.filter((e: { organizationId: string }) => e.organizationId === alphaId)
        .map((e: { action: string }) => e.action);

      expect(actions).toEqual(
        expect.arrayContaining([
          'trial.extended',
          'plan.changed',
          'business.suspended',
          'business.reactivated',
          'member.unlocked',
          'member.signed-out',
          'invitation.reissued',
          'note.added',
          'business.viewed',
        ]),
      );
    });
  });
});
