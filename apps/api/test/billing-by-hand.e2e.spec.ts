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
import { SweepsService } from '../src/notifications/sweeps.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createPrivilegedTestClient, createTestApp } from './create-test-app';

/**
 * Billing by hand (Phase 19b).
 *
 * What matters most, in order:
 *   - only staff can record money, and a business cannot make itself "paying"
 *     any other way while payments are recorded by hand
 *   - a recorded payment, once written, can only ever be voided — proven
 *     against the database, not just the endpoints
 *   - paid time runs out: a business paid for a month is not paying for ever
 *   - credit cannot be spent twice, even by two people at the same moment
 */

const PASSWORD = 'a-sufficiently-long-password';
const DAY = 24 * 60 * 60 * 1000;

interface InjectResult {
  statusCode: number;
  body: string;
  cookies: Array<{ name: string; value: string }>;
}

interface Business {
  token: string;
  userId: string;
  organizationId: string;
}

describe('Billing by hand (e2e)', () => {
  let app: NestFastifyApplication;
  let privileged: PrismaClient;
  let prisma: PrismaService;

  let staffToken: string;
  let staffUserId: string;
  let counter = 0;

  const request = (
    method: 'GET' | 'POST',
    url: string,
    token?: string,
    payload?: unknown,
    on: NestFastifyApplication = app,
  ) =>
    on.inject({
      method,
      url,
      payload: payload as never,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      cookies: token ? { [SESSION_COOKIE_NAME]: token } : undefined,
    }) as unknown as Promise<InjectResult>;

  const json = (r: InjectResult) => JSON.parse(r.body);
  const tokenOf = (r: InjectResult) => r.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  const today = () => new Date().toISOString();

  async function register(email: string, organizationName: string): Promise<Business> {
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

  /** A business of its own for each test, so no test depends on another's leftovers. */
  async function freshBusiness(): Promise<Business> {
    counter += 1;
    return register(`e2e-paid-owner-${counter}@example.test`, `Paid Test ${counter}`);
  }

  const detail = async (organizationId: string) => {
    const response = await request('GET', `/api/v1/staff/businesses/${organizationId}`, staffToken);
    expect(response.statusCode, response.body).toBe(200);
    return json(response);
  };

  const recordPayment = (organizationId: string, body: Record<string, unknown>) =>
    request('POST', `/api/v1/staff/businesses/${organizationId}/payments`, staffToken, {
      method: 'CHECK',
      interval: 'MONTHLY',
      amountCents: 2_900,
      paidAt: today(),
      reason: 'Check received in the post',
      ...body,
    });

  const grantCredit = (organizationId: string, amountCents: number) =>
    request('POST', `/api/v1/staff/businesses/${organizationId}/credits`, staffToken, {
      amountCents,
      reason: 'Outage on the 3rd',
    });

  const canWrite = async (business: Business) =>
    (
      await request('POST', '/api/v1/locations', business.token, {
        name: `Yard ${Math.random()}`,
        timezone: 'UTC',
      })
    ).statusCode;

  async function cleanUp(): Promise<void> {
    await privileged.$executeRawUnsafe(
      "DELETE FROM staff_audit_events WHERE staff_email LIKE 'e2e-paid-%@example.test'",
    );
    await privileged.$executeRawUnsafe(
      "DELETE FROM users WHERE email LIKE 'e2e-paid-%@example.test'",
    );
    await privileged.$executeRawUnsafe("DELETE FROM organizations WHERE name LIKE 'Paid Test%'");
  }

  beforeAll(async () => {
    const created = await createTestApp();
    app = created.app;
    prisma = created.prisma;
    privileged = createPrivilegedTestClient();
    await cleanUp();

    const staff = await register('e2e-paid-staff@example.test', 'Paid Test Home');
    staffToken = staff.token;
    staffUserId = staff.userId;
    await privileged.platformStaff.create({ data: { userId: staffUserId, note: 'e2e' } });
  });

  afterAll(async () => {
    await cleanUp();
    await privileged?.$disconnect();
    await app?.close();
  });

  // =========================================================================

  describe('who may touch the money', () => {
    it('answers a business owner as if the billing routes did not exist', async () => {
      const business = await freshBusiness();
      const base = `/api/v1/staff/businesses/${business.organizationId}`;

      // Payloads that would succeed for staff, so a 404 proves the guard and
      // not the validation.
      const attempts: Array<[string, unknown]> = [
        [
          `${base}/payments`,
          {
            method: 'CHECK',
            interval: 'ANNUAL',
            amountCents: 100,
            paidAt: today(),
            reason: 'Paying ourselves',
          },
        ],
        [`${base}/credits`, { amountCents: 100_000, reason: 'Free money please' }],
        [`${base}/credits/remove`, { amountCents: 1, reason: 'Just looking' }],
      ];

      for (const [url, payload] of attempts) {
        const response = await request('POST', url, business.token, payload);
        expect(response.statusCode, url).toBe(404);
      }

      expect(
        await privileged.billingPayment.count({
          where: { organizationId: business.organizationId },
        }),
      ).toBe(0);
      expect(
        await privileged.billingCredit.count({
          where: { organizationId: business.organizationId },
        }),
      ).toBe(0);
    });
  });

  // =========================================================================

  describe('recording a payment', () => {
    it('lets a business paying during its trial keep the trial days', async () => {
      const business = await freshBusiness();
      const { trialEndsAt } = await privileged.subscription.findUniqueOrThrow({
        where: { organizationId: business.organizationId },
      });

      const response = await recordPayment(business.organizationId, {
        interval: 'ANNUAL',
        amountCents: 34_800,
      });
      expect(response.statusCode, response.body).toBe(204);

      const payment = await privileged.billingPayment.findFirstOrThrow({
        where: { organizationId: business.organizationId },
      });
      expect(payment.coversFrom).toEqual(trialEndsAt);
      expect(payment.recordedByUserId).toBe(staffUserId);
      expect(payment.coversUntil.getUTCFullYear()).toBe(trialEndsAt!.getUTCFullYear() + 1);

      const subscription = await privileged.subscription.findUniqueOrThrow({
        where: { organizationId: business.organizationId },
      });
      expect(subscription.status).toBe('ACTIVE');
      expect(subscription.periodEndsAt).toEqual(payment.coversUntil);

      const { billing } = await detail(business.organizationId);
      expect(billing.paidThrough).toBe(payment.coversUntil.toISOString());
      expect(billing.interval).toBe('ANNUAL');
      // Nothing of the paid year has started yet.
      expect(billing.unusedCents).toBe(34_800);
      expect(billing.daysLeft).toBeGreaterThan(365);
    });

    it('lines a renewal up with the end of the paid time, not the day it was entered', async () => {
      const business = await freshBusiness();

      await recordPayment(business.organizationId, {});
      const first = await privileged.billingPayment.findFirstOrThrow({
        where: { organizationId: business.organizationId },
      });

      expect((await recordPayment(business.organizationId, {})).statusCode).toBe(204);

      const second = await privileged.billingPayment.findFirstOrThrow({
        where: { organizationId: business.organizationId, id: { not: first.id } },
      });
      expect(second.coversFrom).toEqual(first.coversUntil);
    });

    it('starts from today for a lapsed business, and gives it back full access', async () => {
      const business = await freshBusiness();
      await privileged.subscription.update({
        where: { organizationId: business.organizationId },
        data: { status: 'SUSPENDED', trialEndsAt: new Date(Date.now() - 30 * DAY) },
      });
      expect(await canWrite(business)).toBe(403);

      const before = Date.now();
      expect((await recordPayment(business.organizationId, {})).statusCode).toBe(204);

      const payment = await privileged.billingPayment.findFirstOrThrow({
        where: { organizationId: business.organizationId },
      });
      // Not charged for the month it spent read-only.
      expect(payment.coversFrom.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(await canWrite(business)).toBe(201);
    });

    it('refuses an amount on a complimentary period, and no amount on a paid one', async () => {
      const business = await freshBusiness();

      const comped = await recordPayment(business.organizationId, {
        method: 'COMPLIMENTARY',
        amountCents: 500,
      });
      expect(comped.statusCode).toBe(400);

      const empty = await recordPayment(business.organizationId, { amountCents: 0 });
      expect(empty.statusCode).toBe(400);

      const free = await recordPayment(business.organizationId, {
        method: 'COMPLIMENTARY',
        amountCents: 0,
        reason: 'Research participant',
      });
      expect(free.statusCode, free.body).toBe(204);
    });

    it('refuses a payment dated in the future', async () => {
      const business = await freshBusiness();

      const response = await recordPayment(business.organizationId, {
        paidAt: new Date(Date.now() + 5 * DAY).toISOString(),
      });

      expect(response.statusCode).toBe(400);
    });

    it('records the payment, and why, in the audit trail', async () => {
      const business = await freshBusiness();
      await recordPayment(business.organizationId, { reason: 'Paid by check #1042' });

      const entry = await privileged.staffAuditEvent.findFirstOrThrow({
        where: { organizationId: business.organizationId, action: 'payment.recorded' },
      });
      expect(entry.reason).toBe('Paid by check #1042');
      expect(entry.staffEmail).toBe('e2e-paid-staff@example.test');
    });

    it('shows the business what it paid, without who recorded it or why', async () => {
      const business = await freshBusiness();
      await recordPayment(business.organizationId, { reason: 'Internal: gave them a discount' });

      const response = await request('GET', '/api/v1/billing/subscription', business.token);
      expect(response.statusCode, response.body).toBe(200);

      const { account, subscription } = json(response);
      expect(subscription.status).toBe('ACTIVE');
      expect(account.payments).toHaveLength(1);
      expect(account.paidThrough).toBe(account.payments[0].coversUntil);
      expect(response.body).not.toContain('discount');
      expect(response.body).not.toContain('e2e-paid-staff');
    });

    it('will not hand a lapsed payer a free trial', async () => {
      const business = await freshBusiness();
      await recordPayment(business.organizationId, {});

      // Paid time over and recorded as read-only by the sweep. It still carries
      // its old trial date, which is exactly what made it look like a lapsed trial.
      await privileged.subscription.update({
        where: { organizationId: business.organizationId },
        data: { status: 'SUSPENDED', periodEndsAt: new Date(Date.now() - 60 * DAY) },
      });

      const response = await request(
        'POST',
        `/api/v1/staff/businesses/${business.organizationId}/trial`,
        staffToken,
        { until: new Date(Date.now() + 14 * DAY).toISOString(), reason: 'Wants more time' },
      );

      expect(response.statusCode).toBe(400);
    });
  });

  // =========================================================================

  describe('credit', () => {
    it('can be given, spent on a payment, and taken back, never below zero', async () => {
      const business = await freshBusiness();

      expect((await grantCredit(business.organizationId, 5_000)).statusCode).toBe(204);

      const spent = await recordPayment(business.organizationId, {
        amountCents: 0,
        creditAppliedCents: 3_000,
      });
      expect(spent.statusCode, spent.body).toBe(204);
      expect((await detail(business.organizationId)).billing.creditBalanceCents).toBe(2_000);

      // More than is left: refused, and nothing written.
      const overspend = await recordPayment(business.organizationId, {
        creditAppliedCents: 2_001,
      });
      expect(overspend.statusCode).toBe(400);
      expect(
        await privileged.billingPayment.count({
          where: { organizationId: business.organizationId },
        }),
      ).toBe(1);

      const overRemove = await request(
        'POST',
        `/api/v1/staff/businesses/${business.organizationId}/credits/remove`,
        staffToken,
        { amountCents: 2_001, reason: 'Given in error' },
      );
      expect(overRemove.statusCode).toBe(400);

      const remove = await request(
        'POST',
        `/api/v1/staff/businesses/${business.organizationId}/credits/remove`,
        staffToken,
        { amountCents: 2_000, reason: 'Given in error' },
      );
      expect(remove.statusCode, remove.body).toBe(204);
      expect((await detail(business.organizationId)).billing.creditBalanceCents).toBe(0);
    });

    it('cannot be spent twice by two people at the same moment', async () => {
      const business = await freshBusiness();
      await grantCredit(business.organizationId, 1_000);

      const results = await Promise.all([
        recordPayment(business.organizationId, { amountCents: 0, creditAppliedCents: 1_000 }),
        recordPayment(business.organizationId, { amountCents: 0, creditAppliedCents: 1_000 }),
      ]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400]);

      const balance = await privileged.billingCredit.aggregate({
        where: { organizationId: business.organizationId },
        _sum: { amountCents: true },
      });
      expect(balance._sum.amountCents).toBe(0);
    });
  });

  // =========================================================================

  describe('voiding a payment', () => {
    it('works the paid time out again and gives back credit spent on it', async () => {
      const business = await freshBusiness();
      await grantCredit(business.organizationId, 1_000);
      await recordPayment(business.organizationId, {});
      await recordPayment(business.organizationId, {
        amountCents: 1_900,
        creditAppliedCents: 1_000,
      });

      const payments = await privileged.billingPayment.findMany({
        where: { organizationId: business.organizationId },
        orderBy: { coversUntil: 'asc' },
      });
      const [first, second] = payments;

      const response = await request(
        'POST',
        `/api/v1/staff/businesses/${business.organizationId}/payments/${second!.id}/void`,
        staffToken,
        { reason: 'Entered twice by mistake' },
      );
      expect(response.statusCode, response.body).toBe(204);

      const { billing } = await detail(business.organizationId);
      expect(billing.paidThrough).toBe(first!.coversUntil.toISOString());
      expect(billing.creditBalanceCents).toBe(1_000);

      // Still there, marked, with who and why.
      const voided = billing.payments.find((p: { id: string }) => p.id === second!.id);
      expect(voided.voidedByEmail).toBe('e2e-paid-staff@example.test');
      expect(voided.voidReason).toBe('Entered twice by mistake');

      const again = await request(
        'POST',
        `/api/v1/staff/businesses/${business.organizationId}/payments/${second!.id}/void`,
        staffToken,
        { reason: 'Once more' },
      );
      expect(again.statusCode).toBe(400);
    });

    it('puts a business back on its trial when its only payment is voided', async () => {
      const business = await freshBusiness();
      await recordPayment(business.organizationId, {});
      const payment = await privileged.billingPayment.findFirstOrThrow({
        where: { organizationId: business.organizationId },
      });

      await request(
        'POST',
        `/api/v1/staff/businesses/${business.organizationId}/payments/${payment.id}/void`,
        staffToken,
        { reason: 'Check bounced' },
      );

      const subscription = await privileged.subscription.findUniqueOrThrow({
        where: { organizationId: business.organizationId },
      });
      expect(subscription.status).toBe('TRIALING');
      expect(subscription.periodEndsAt).toEqual(subscription.trialEndsAt);
    });

    it("will not void one business's payment through another's page", async () => {
      const owner = await freshBusiness();
      const other = await freshBusiness();
      await recordPayment(owner.organizationId, {});
      const payment = await privileged.billingPayment.findFirstOrThrow({
        where: { organizationId: owner.organizationId },
      });

      const response = await request(
        'POST',
        `/api/v1/staff/businesses/${other.organizationId}/payments/${payment.id}/void`,
        staffToken,
        { reason: 'Wrong page' },
      );

      expect(response.statusCode).toBe(404);
      expect(
        (await privileged.billingPayment.findUniqueOrThrow({ where: { id: payment.id } })).voidedAt,
      ).toBeNull();
    });
  });

  // =========================================================================

  describe('what the database allows', () => {
    let business: Business;
    let paymentId: string;

    beforeAll(async () => {
      business = await freshBusiness();
      await recordPayment(business.organizationId, {});
      await grantCredit(business.organizationId, 500);
      paymentId = (
        await privileged.billingPayment.findFirstOrThrow({
          where: { organizationId: business.organizationId },
        })
      ).id;
    });

    it('does not let even staff change what a payment says', async () => {
      await expect(
        prisma.withStaff(staffUserId, (tx) =>
          tx.billingPayment.update({ where: { id: paymentId }, data: { amountCents: 1 } }),
        ),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        prisma.withStaff(staffUserId, (tx) =>
          tx.billingPayment.update({
            where: { id: paymentId },
            data: { coversUntil: new Date(Date.now() + 3650 * DAY) },
          }),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('does not let payments or credit be deleted', async () => {
      await expect(
        prisma.withStaff(staffUserId, (tx) => tx.billingPayment.deleteMany({})),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        prisma.withStaff(staffUserId, (tx) => tx.billingCredit.deleteMany({})),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        prisma.withStaff(staffUserId, (tx) =>
          tx.billingCredit.updateMany({ data: { amountCents: 999_999 } }),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('does not let a voided payment be un-voided or voided again', async () => {
      const other = await freshBusiness();
      await recordPayment(other.organizationId, {});
      const payment = await privileged.billingPayment.findFirstOrThrow({
        where: { organizationId: other.organizationId },
      });
      await request(
        'POST',
        `/api/v1/staff/businesses/${other.organizationId}/payments/${payment.id}/void`,
        staffToken,
        { reason: 'Mistake' },
      );

      const result = await prisma.withStaff(staffUserId, (tx) =>
        tx.billingPayment.updateMany({
          where: { id: payment.id },
          data: {
            voidedAt: null,
            voidedByUserId: null,
            voidedByEmail: null,
            voidReason: null,
          },
        }),
      );

      expect(result.count).toBe(0);
      expect(
        (await privileged.billingPayment.findUniqueOrThrow({ where: { id: payment.id } })).voidedAt,
      ).not.toBeNull();
    });

    it('does not let a payment claim someone else recorded it', async () => {
      await expect(
        prisma.withStaff(staffUserId, (tx) =>
          tx.billingPayment.create({
            data: {
              organizationId: business.organizationId,
              amountCents: 100,
              method: 'CASH',
              interval: 'MONTHLY',
              planKey: 'starter',
              paidAt: new Date(),
              coversFrom: new Date(),
              coversUntil: new Date(Date.now() + 30 * DAY),
              recordedByUserId: business.userId,
              recordedByEmail: 'someone-else@example.test',
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('does not let a credit "grant" take money away', async () => {
      await expect(
        prisma.withStaff(staffUserId, (tx) =>
          tx.billingCredit.create({
            data: {
              organizationId: business.organizationId,
              kind: 'GRANTED',
              amountCents: -500,
              reason: 'Sneaky',
              staffUserId,
              staffEmail: 'e2e-paid-staff@example.test',
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('lets a business read its own payments and credit, and write neither', async () => {
      const context = { organizationId: business.organizationId, userId: business.userId };

      const seen = await prisma.withTenant(context, (tx) => tx.billingPayment.findMany());
      expect(seen.map((p) => p.id)).toEqual([paymentId]);

      await expect(
        prisma.withTenant(context, (tx) =>
          tx.billingCredit.create({
            data: {
              organizationId: business.organizationId,
              kind: 'GRANTED',
              amountCents: 100_000,
              reason: 'Free money',
              staffUserId: business.userId,
              staffEmail: 'owner@example.test',
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it("never shows one business another's payments", async () => {
      const other = await freshBusiness();

      const seen = await prisma.withTenant(
        { organizationId: other.organizationId, userId: other.userId },
        (tx) => tx.billingPayment.findMany({ where: { organizationId: business.organizationId } }),
      );

      expect(seen).toHaveLength(0);
    });

    it('grants nothing to someone who is not staff, even with the flag set', async () => {
      const seen = await prisma.withStaff(business.userId, (tx) =>
        tx.billingPayment.findMany({ where: { organizationId: business.organizationId } }),
      );

      expect(seen).toHaveLength(0);
    });
  });

  // =========================================================================

  describe('when paid time runs out', () => {
    async function paidUntil(business: Business, periodEndsAt: Date): Promise<void> {
      // Starter promises 14 days of grace; the trial plan promises none.
      await privileged.subscription.update({
        where: { organizationId: business.organizationId },
        data: { planKey: 'starter', status: 'ACTIVE', periodEndsAt, trialEndsAt: null },
      });
    }

    it('keeps full access through the grace period after the paid time', async () => {
      const business = await freshBusiness();
      await paidUntil(business, new Date(Date.now() - 3 * DAY));

      expect(await canWrite(business)).toBe(201);

      const response = await request('GET', '/api/v1/billing/subscription', business.token);
      expect(json(response).subscription.status).toBe('PAST_DUE');
    });

    it('turns read-only once that grace is over, without waiting for the sweep', async () => {
      const business = await freshBusiness();
      await paidUntil(business, new Date(Date.now() - 15 * DAY));

      expect(await canWrite(business)).toBe(403);
    });

    it('is recorded once by the sweep, which tells the owner a payment is due', async () => {
      const business = await freshBusiness();
      const ended = new Date(Date.now() - 3 * DAY);
      await paidUntil(business, ended);

      const sweeps = app.get(SweepsService);
      await sweeps.run();
      await sweeps.run();

      const subscription = await privileged.subscription.findUniqueOrThrow({
        where: { organizationId: business.organizationId },
      });
      expect(subscription.status).toBe('PAST_DUE');
      // Grace counts from the end of the paid time, not from when it was noticed.
      expect(subscription.graceEndsAt).toEqual(new Date(ended.getTime() + 14 * DAY));

      const events = await privileged.domainEvent.findMany({
        where: { organizationId: business.organizationId, type: 'subscription.past_due' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({ reason: 'period_ended' });
    });

    it('leaves a business alone whose payment arrived in time', async () => {
      const business = await freshBusiness();
      await recordPayment(business.organizationId, {});

      await app.get(SweepsService).run();

      expect(
        (
          await privileged.subscription.findUniqueOrThrow({
            where: { organizationId: business.organizationId },
          })
        ).status,
      ).toBe('ACTIVE');
    });
  });

  // =========================================================================

  describe('the overview', () => {
    it('counts money collected and renewals coming up', async () => {
      const business = await freshBusiness();
      await privileged.subscription.update({
        where: { organizationId: business.organizationId },
        data: { status: 'SUSPENDED', trialEndsAt: new Date(Date.now() - DAY) },
      });
      await recordPayment(business.organizationId, { amountCents: 4_200 });

      const overview = json(await request('GET', '/api/v1/staff/overview', staffToken));
      expect(overview.collectedLast30DaysCents).toBeGreaterThanOrEqual(4_200);
      expect(overview.renewalsDueSoon).toBeGreaterThanOrEqual(1);

      const due = json(
        await request('GET', '/api/v1/staff/businesses?filter=renewal-due', staffToken),
      );
      expect(due.businesses.map((b: { id: string }) => b.id)).toContain(business.organizationId);
    });
  });

  // =========================================================================

  describe('while payments are recorded by hand', () => {
    let handBilled: NestFastifyApplication;

    beforeAll(async () => {
      // What production runs with. The factory reads the environment when the
      // module compiles, so setting it here, before creating the app, is enough.
      process.env.BILLING_SIMULATION = 'false';
      try {
        handBilled = (await createTestApp()).app;
      } finally {
        delete process.env.BILLING_SIMULATION;
      }
    });

    afterAll(async () => {
      await handBilled?.close();
    });

    it('does not let a business mark itself as paying', async () => {
      const business = await freshBusiness();

      const plan = await request(
        'POST',
        '/api/v1/billing/plan',
        business.token,
        { planKey: 'business' },
        handBilled,
      );
      expect(plan.statusCode).toBe(404);

      const paid = await request(
        'POST',
        '/api/v1/billing/events',
        business.token,
        { event: 'payment_succeeded' },
        handBilled,
      );
      expect(paid.statusCode).toBe(404);

      const subscription = await privileged.subscription.findUniqueOrThrow({
        where: { organizationId: business.organizationId },
      });
      expect(subscription.status).toBe('TRIALING');
      expect(subscription.planKey).toBe('trial');
    });

    it('tells the billing page to send them to us instead', async () => {
      const business = await freshBusiness();

      const response = await request(
        'GET',
        '/api/v1/billing/subscription',
        business.token,
        undefined,
        handBilled,
      );

      expect(json(response).account.selfServe).toBe(false);
    });
  });
});
