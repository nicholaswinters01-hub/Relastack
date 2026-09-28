import 'reflect-metadata';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

process.env.RATE_LIMIT_ENABLED = 'false';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MODULES, PERMISSIONS, SESSION_COOKIE_NAME, SYSTEM_ROLE_IDS } from '@platform/shared';
import type { PrismaClient } from '@platform/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Plans, subscriptions, and what a lapse does to access.
 *
 * The behaviour that matters most here is the grace period: a failed payment
 * must NOT lock a business out mid-job. Access stays full while they are
 * chased, then narrows to read-only — never to nothing.
 */

const PASSWORD = 'a-sufficiently-long-password';

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

describe('Billing and subscriptions (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;

  let token: string;
  let organizationId: string;

  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    authToken?: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: authToken ? { [SESSION_COOKIE_NAME]: authToken } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (response: InjectResult) => JSON.parse(response.body);

  /** Drive the subscription into a state, as a provider webhook will later. */
  const event = (name: string) => request('POST', '/api/v1/billing/events', token, { event: name });

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-bill-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Billing Test%'");
  }

  beforeAll(async () => {
    ({ app } = await createTestApp());
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const registration = await request('POST', '/api/v1/auth/register', undefined, {
      email: 'e2e-bill-owner@example.test',
      password: PASSWORD,
      organizationName: 'Billing Test Company',
    });
    expect(registration.statusCode, registration.body).toBe(201);

    token = registration.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const membership = await privileged.organizationMembership.findFirstOrThrow({
      where: { userId: json(registration).user.id },
    });
    organizationId = membership.organizationId;
  });

  beforeEach(async () => {
    // Back to a clean trial with no locations.
    await privileged.$executeRawUnsafe(
      `DELETE FROM locations WHERE organization_id = '${organizationId}'`,
    );
    await privileged.subscriptionAddOn.deleteMany({ where: { organizationId } });
    await privileged.subscription.update({
      where: { organizationId },
      data: {
        planKey: 'trial',
        status: 'TRIALING',
        graceEndsAt: null,
        cancelledAt: null,
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        periodEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // -------------------------------------------------------------------------

  describe('registration', () => {
    it('starts every new organization on a trial', async () => {
      const response = await request('GET', '/api/v1/billing/subscription', token);

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).subscription.planKey).toBe('trial');
      expect(json(response).subscription.status).toBe('TRIALING');
      expect(json(response).subscription.accessLevel).toBe('full');
    });

    it('creates the subscription in the same transaction as the organization', async () => {
      // An organization committed without one would resolve to no modules and
      // be locked out of its own account.
      const orphans = await privileged.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT count(*) FROM organizations o LEFT JOIN subscriptions s ON s.organization_id = o.id WHERE s.id IS NULL',
      );

      expect(Number(orphans[0]!.count)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('plans', () => {
    it('lists the public price list', async () => {
      const response = await request('GET', '/api/v1/billing/plans', token);
      const keys = json(response).plans.map((p: { key: string }) => p.key);

      expect(keys).toEqual(expect.arrayContaining(['core', 'pro', 'business_v2']));
      // Retired plans stay for whoever is on one, but are not offered.
      expect(keys).not.toContain('starter');
      expect(keys).not.toContain('enterprise');
      // The trial is not offered as a choice.
      expect(keys).not.toContain('trial');
    });

    it('shows the price list to someone who is not signed in, and nothing else', async () => {
      const response = await request('GET', '/api/v1/plans');

      expect(response.statusCode, response.body).toBe(200);
      const body = json(response);
      // Plans only: no subscription, no account, nothing about any business.
      expect(Object.keys(body)).toEqual(['plans']);
      const keys = body.plans.map((p: { key: string }) => p.key);
      expect(keys).toEqual(expect.arrayContaining(['core', 'pro', 'business_v2']));
      expect(keys).not.toContain('trial');

      // The comparison page's extra rows arrive parsed, with what each plan offers.
      const pro = body.plans.find((p: { key: string }) => p.key === 'pro');
      expect(pro.comparisonExtras).toEqual(
        expect.arrayContaining([
          { label: 'Customer portal', value: true, comingSoon: true },
          { label: 'Support', value: 'Faster replies', comingSoon: false },
        ]),
      );
      const core = body.plans.find((p: { key: string }) => p.key === 'core');
      expect(core.comparisonExtras).toEqual(
        expect.arrayContaining([{ label: 'Customer portal', value: false, comingSoon: true }]),
      );
    });

    it('still keeps the signed-in billing routes behind sign-in', async () => {
      // Opening the price list must not have opened the controller beside it.
      expect((await request('GET', '/api/v1/billing/plans')).statusCode).toBe(401);
      expect((await request('GET', '/api/v1/billing/subscription')).statusCode).toBe(401);
    });

    it('never prices by user count', async () => {
      const response = await request('GET', '/api/v1/billing/plans', token);

      // The commercial model: billed by location, never per employee.
      for (const plan of json(response).plans) {
        expect(plan).not.toHaveProperty('perUserPriceCents');
        expect(plan).toHaveProperty('perLocationPriceCents');
      }
    });

    it('moves to a paid plan', async () => {
      const response = await request('POST', '/api/v1/billing/plan', token, {
        planKey: 'business',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).subscription.planKey).toBe('business');
      // Choosing a plan ends the trial.
      expect(json(response).subscription.status).toBe('ACTIVE');
    });

    it('rejects an unknown plan', async () => {
      const response = await request('POST', '/api/v1/billing/plan', token, {
        planKey: 'platinum_deluxe',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------

  describe('entitlement follows the plan', () => {
    it('grants only what the plan includes', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'starter' });

      const response = await request('GET', '/api/v1/modules', token);
      const entitled = json(response)
        .modules.filter((m: { entitled: boolean }) => m.entitled)
        .map((m: { key: string }) => m.key);

      expect(entitled.sort()).toEqual([MODULES.CORE, MODULES.CRM].sort());
    });

    it('refuses to enable a module the plan does not cover', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'starter' });

      const response = await request('POST', `/api/v1/modules/${MODULES.INVENTORY}`, token);

      // 403 with an upgrade path, not 404: the module plainly exists, and the
      // interface needs to be able to offer it.
      expect(response.statusCode).toBe(403);
      expect(json(response).code).toBe('REQUIRES_UPGRADE');
    });

    it('allows it once the plan covers it', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'enterprise' });

      const response = await request('POST', `/api/v1/modules/${MODULES.INVENTORY}`, token);

      expect(response.statusCode, response.body).toBe(200);
    });

    it('an add-on grants a module outside the plan', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'starter' });

      const subscription = await privileged.subscription.findUniqueOrThrow({
        where: { organizationId },
      });
      await privileged.subscriptionAddOn.create({
        data: {
          subscriptionId: subscription.id,
          moduleKey: MODULES.INVENTORY,
          priceCents: 900,
          organizationId,
        },
      });

      const response = await request('POST', `/api/v1/modules/${MODULES.INVENTORY}`, token);
      expect(response.statusCode, response.body).toBe(200);
    });

    it('a downgrade closes a real endpoint, not just a flag in a list', async () => {
      // The assertion that matters commercially. Hiding a button is not
      // enforcement: the plan has to stop the request itself.
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'enterprise' });
      await request('POST', `/api/v1/modules/${MODULES.CUSTOM_ROLES}`, token);

      const allowed = await request('POST', '/api/v1/roles', token, {
        key: 'shift_lead',
        name: 'Shift Lead',
        defaultScope: 'LOCATION',
        permissions: [PERMISSIONS.LOCATION_READ],
      });
      expect(allowed.statusCode, allowed.body).toBe(201);

      await request('POST', '/api/v1/billing/plan', token, { planKey: 'starter' });

      const refused = await request('POST', '/api/v1/roles', token, {
        key: 'another_lead',
        name: 'Another Lead',
        defaultScope: 'LOCATION',
        permissions: [PERMISSIONS.LOCATION_READ],
      });

      expect(refused.statusCode).toBe(403);
      expect(json(refused).code).toBe('MODULE_NOT_ENABLED');

      // And the role they already made still works. A billing change must
      // never destroy data.
      const roles = await request('GET', '/api/v1/roles', token);
      expect(json(roles).roles.some((r: { key: string }) => r.key === 'shift_lead')).toBe(true);
    });

    it('a downgrade stops access without erasing the choice', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'enterprise' });
      await request('POST', `/api/v1/modules/${MODULES.INVENTORY}`, token);

      await request('POST', '/api/v1/billing/plan', token, { planKey: 'starter' });

      const modules = await request('GET', '/api/v1/modules', token);
      const inventory = json(modules).modules.find(
        (m: { key: string }) => m.key === MODULES.INVENTORY,
      );

      // Not entitled, so not available — but the row saying they wanted it
      // survives, so upgrading restores exactly what they had.
      expect(inventory.enabled).toBe(false);
      expect(inventory.entitled).toBe(false);

      const stillChosen = await privileged.organizationModule.findFirst({
        where: { organizationId, moduleKey: MODULES.INVENTORY },
      });
      expect(stillChosen?.enabled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------

  describe('location entitlement', () => {
    const makeLocation = (name: string) =>
      request('POST', '/api/v1/locations', token, { name, timezone: 'UTC' });

    it('allows locations up to the plan limit', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'starter' });

      expect((await makeLocation('Only Branch')).statusCode).toBe(201);
    });

    it('refuses the one that would exceed it', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'starter' });
      await makeLocation('Only Branch');

      const response = await makeLocation('Second Branch');

      expect(response.statusCode).toBe(403);
      expect(json(response).code).toBe('LOCATION_LIMIT_REACHED');
      expect(json(response).maxLocations).toBe(1);
    });

    it('allows more after an upgrade', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'starter' });
      await makeLocation('Only Branch');
      expect((await makeLocation('Second Branch')).statusCode).toBe(403);

      await request('POST', '/api/v1/billing/plan', token, { planKey: 'business' });

      expect((await makeLocation('Second Branch')).statusCode).toBe(201);
    });

    it('refuses a downgrade the organization has outgrown', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'business' });
      await makeLocation('One');
      await makeLocation('Two');

      const response = await request('POST', '/api/v1/billing/plan', token, {
        planKey: 'starter',
      });

      // Silently orphaning — or deleting — locations would be a destructive
      // surprise triggered by a billing change.
      expect(response.statusCode).toBe(400);
      expect(json(response).message).toContain('2');
    });

    it('bills by location and reports that users are free', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'business' });
      for (const name of ['One', 'Two', 'Three', 'Four']) await makeLocation(name);

      const response = await request('GET', '/api/v1/billing/subscription', token);
      const { summary } = json(response);

      // Business: 7900 base, 3 included, 1500 per location beyond.
      expect(summary.activeLocations).toBe(4);
      expect(summary.billableLocations).toBe(1);
      expect(summary.totalCents).toBe(7900 + 1500);
      // Reported so the interface can say adding staff costs nothing. Never an
      // input to the total.
      expect(summary.userCount).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('a failed payment — the grace period', () => {
    it('keeps FULL access while grace runs', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'business' });

      const failed = await event('payment_failed');

      expect(json(failed).subscription.status).toBe('PAST_DUE');
      // The whole point: a landscaping company must not be locked out mid-job
      // because a card expired.
      expect(json(failed).subscription.accessLevel).toBe('full');
      expect(json(failed).subscription.graceEndsAt).not.toBeNull();

      const write = await request('POST', '/api/v1/locations', token, {
        name: 'Still Working',
        timezone: 'UTC',
      });
      expect(write.statusCode).toBe(201);
    });

    it('narrows to read-only once grace expires', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'business' });
      await event('payment_failed');

      // Wind the clock back rather than waiting fourteen days.
      await privileged.subscription.update({
        where: { organizationId },
        data: { graceEndsAt: new Date(Date.now() - 1000) },
      });

      const response = await request('GET', '/api/v1/billing/subscription', token);

      // Computed on read, so an expiry at 3am takes effect at 3am rather than
      // whenever a job next runs.
      expect(json(response).subscription.status).toBe('SUSPENDED');
      expect(json(response).subscription.accessLevel).toBe('read-only');
    });

    it('recovers fully when payment succeeds', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'business' });
      await event('payment_failed');
      const recovered = await event('payment_succeeded');

      expect(json(recovered).subscription.status).toBe('ACTIVE');
      expect(json(recovered).subscription.accessLevel).toBe('full');
      expect(json(recovered).subscription.graceEndsAt).toBeNull();
    });

    it('treats an expired trial the same way', async () => {
      await privileged.subscription.update({
        where: { organizationId },
        data: { trialEndsAt: new Date(Date.now() - 1000) },
      });

      const response = await request('GET', '/api/v1/billing/subscription', token);

      expect(json(response).subscription.accessLevel).toBe('read-only');
    });
  });

  // -------------------------------------------------------------------------

  describe('read-only enforcement', () => {
    beforeEach(async () => {
      await privileged.subscription.update({
        where: { organizationId },
        data: { planKey: 'business', status: 'SUSPENDED' },
      });
    });

    it('still allows every read', async () => {
      // A customer who cannot reach their own data has no reason to come back.
      for (const url of [
        '/api/v1/organizations/current',
        '/api/v1/locations',
        '/api/v1/modules',
        '/api/v1/billing/subscription',
      ]) {
        const response = await request('GET', url, token);
        expect(response.statusCode, `${url} -> ${response.body}`).toBe(200);
      }
    });

    it('refuses writes with an explanation', async () => {
      const response = await request('POST', '/api/v1/locations', token, {
        name: 'Blocked Branch',
        timezone: 'UTC',
      });

      expect(response.statusCode).toBe(403);
      expect(json(response).code).toBe('SUBSCRIPTION_READ_ONLY');
      expect(json(response).message).toContain('read-only');
    });

    it('refuses every mutating method', async () => {
      const patch = await request('PATCH', '/api/v1/organizations/current', token, {
        name: 'Billing Test Renamed',
      });
      const post = await request('POST', `/api/v1/modules/${MODULES.CRM}`, token);
      const del = await request('DELETE', `/api/v1/modules/${MODULES.CRM}`, token);

      for (const response of [patch, post, del]) {
        expect(response.statusCode).toBe(403);
        expect(json(response).code).toBe('SUBSCRIPTION_READ_ONLY');
      }
    });

    it('STILL allows the customer to pay their way out', async () => {
      // Locking billing behind the lapse it is meant to fix would be a trap of
      // our own making.
      const response = await request('POST', '/api/v1/billing/plan', token, {
        planKey: 'business',
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(json(response).subscription.accessLevel).toBe('full');
    });

    it('restores writing the moment the subscription is active again', async () => {
      expect(
        (
          await request('POST', '/api/v1/locations', token, {
            name: 'Reopened Branch',
            timezone: 'UTC',
          })
        ).statusCode,
      ).toBe(403);

      await request('POST', '/api/v1/billing/plan', token, { planKey: 'business' });

      expect(
        (
          await request('POST', '/api/v1/locations', token, {
            name: 'Reopened Branch',
            timezone: 'UTC',
          })
        ).statusCode,
      ).toBe(201);
    });

    it('leaves signing out possible', async () => {
      // Identity endpoints must never be trapped behind a billing state.
      expect((await request('GET', '/api/v1/auth/me', token)).statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------

  describe('cancellation', () => {
    it('leaves the account readable so data can be exported', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'business' });
      const cancelled = await event('cancel');

      expect(json(cancelled).subscription.status).toBe('CANCELLED');
      expect(json(cancelled).subscription.accessLevel).toBe('read-only');

      expect((await request('GET', '/api/v1/locations', token)).statusCode).toBe(200);
    });

    it('can be resumed', async () => {
      await request('POST', '/api/v1/billing/plan', token, { planKey: 'business' });
      await event('cancel');
      const resumed = await event('resume');

      expect(json(resumed).subscription.status).toBe('ACTIVE');
      expect(json(resumed).subscription.accessLevel).toBe('full');
    });
  });

  // -------------------------------------------------------------------------

  describe('isolation and authorization', () => {
    it('requires organization-wide authority to change plan', async () => {
      const other = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-bill-emp@example.test',
        password: PASSWORD,
        organizationName: 'Billing Test Throwaway',
      });
      const userId = json(other).user.id;

      await privileged.organizationMembership.deleteMany({ where: { userId } });
      await privileged.$executeRawUnsafe(
        "DELETE FROM organizations WHERE name = 'Billing Test Throwaway'",
      );

      const membership = await privileged.organizationMembership.create({
        data: { userId, organizationId, role: 'MEMBER' },
      });
      await privileged.membershipRole.create({
        data: {
          membershipId: membership.id,
          roleId: SYSTEM_ROLE_IDS.employee,
          scope: 'ORGANIZATION',
          organizationId,
        },
      });

      const login = await request('POST', '/api/v1/auth/login', undefined, {
        email: 'e2e-bill-emp@example.test',
        password: PASSWORD,
      });
      const empToken = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      const change = await request('POST', '/api/v1/billing/plan', empToken, {
        planKey: 'enterprise',
      });
      expect(change.statusCode).toBe(403);

      // But an employee may still see what the company is on.
      expect((await request('GET', '/api/v1/billing/subscription', empToken)).statusCode).toBe(200);

      await privileged.user.deleteMany({ where: { email: 'e2e-bill-emp@example.test' } });
    });

    it('requires authentication', async () => {
      expect((await request('GET', '/api/v1/billing/subscription')).statusCode).toBe(401);
      expect(
        (await request('POST', '/api/v1/billing/plan', undefined, { planKey: 'business' }))
          .statusCode,
      ).toBe(401);
    });

    it('row-level security hides one subscription from another organization', async () => {
      const other = await request('POST', '/api/v1/auth/register', undefined, {
        email: 'e2e-bill-other@example.test',
        password: PASSWORD,
        organizationName: 'Billing Test Other',
      });
      const otherToken = other.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;

      await request('POST', '/api/v1/billing/plan', token, { planKey: 'enterprise' });

      const theirs = await request('GET', '/api/v1/billing/subscription', otherToken);

      expect(json(theirs).subscription.planKey).toBe('trial');
      expect(json(theirs).subscription.planKey).not.toBe('enterprise');
    });
  });
});
