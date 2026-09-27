import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TransactionClient } from '@platform/db';
import {
  addBillingInterval,
  creditBalance,
  daysUntil,
  effectiveSubscriptionStatus,
  monthlyCharge,
  nextCoverageStart,
  paidThroughOf,
  unusedValue,
  type RecordPaymentRequest,
  type StaffBilling,
  type SubscriptionStatus,
} from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import { recordStaffEvent } from './staff-audit';
import type { StaffIdentity } from './staff.decorators';

const DAY = 24 * 60 * 60 * 1000;

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

type SubscriptionWithPlan = NonNullable<Awaited<ReturnType<StaffBillingService['lockAccount']>>>;

/**
 * Billing by hand: payments staff record, and the credit a business holds.
 *
 * Until Phase 18 connects a payment provider, a recorded payment is the only
 * thing that makes a business "paying". The subscription is paid through the
 * end of the latest unvoided payment, and is recomputed from the payments
 * after every change rather than nudged, so it can never disagree with them.
 *
 * Every change locks the business's subscription row first. Two people
 * spending the same credit at the same moment would otherwise both see enough
 * of it.
 */
@Injectable()
export class StaffBillingService {
  constructor(private readonly prisma: PrismaService) {}

  /** The billing picture for the business page. Runs inside the caller's transaction. */
  async billingFor(
    tx: TransactionClient,
    organizationId: string,
    subscription: {
      status: SubscriptionStatus;
      graceEndsAt: Date | null;
      trialEndsAt: Date | null;
      periodEndsAt: Date;
      plan: Parameters<typeof monthlyCharge>[0] & {
        gracePeriodDays: number;
        annualBillingMonths: number;
      };
      addOns: Array<{ priceCents: number }>;
    } | null,
    activeLocations: number,
    now: number,
  ): Promise<StaffBilling> {
    const [payments, credits] = await Promise.all([
      tx.billingPayment.findMany({ where: { organizationId }, orderBy: { paidAt: 'desc' } }),
      tx.billingCredit.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' } }),
    ]);

    const live = payments.filter((payment) => payment.voidedAt === null);
    const paidThrough = paidThroughOf(live);
    const latest = [...live].sort((a, b) => b.coversUntil.getTime() - a.coversUntil.getTime())[0];
    const { unusedCents, paidCents } = unusedValue(live, now);

    const monthly = subscription
      ? monthlyCharge(
          subscription.plan,
          activeLocations,
          subscription.addOns.map((entry) => entry.priceCents),
        ).totalCents
      : 0;

    const coverageStart = subscription
      ? nextCoverageStart(
          {
            effectiveStatus: effectiveSubscriptionStatus(subscription, now),
            trialEndsAt: subscription.trialEndsAt,
            paidThrough,
          },
          now,
        )
      : new Date(now);

    return {
      paidThrough: paidThrough?.toISOString() ?? null,
      interval: latest?.interval ?? null,
      daysLeft: paidThrough ? daysUntil(paidThrough, now) : 0,
      paidForCurrentTimeCents: paidCents,
      unusedCents,
      creditBalanceCents: creditBalance(credits),
      nextCoverageStartsAt: coverageStart.toISOString(),
      suggestedCents: {
        MONTHLY: monthly,
        // The plan says how many months a year up front costs.
        ANNUAL: monthly * (subscription?.plan.annualBillingMonths ?? 12),
      },
      payments: payments.map((payment) => ({
        id: payment.id,
        amountCents: payment.amountCents,
        creditAppliedCents: payment.creditAppliedCents,
        method: payment.method,
        interval: payment.interval,
        planKey: payment.planKey,
        reference: payment.reference,
        paidAt: payment.paidAt.toISOString(),
        coversFrom: payment.coversFrom.toISOString(),
        coversUntil: payment.coversUntil.toISOString(),
        recordedByEmail: payment.recordedByEmail,
        note: payment.note,
        voidedAt: payment.voidedAt?.toISOString() ?? null,
        voidedByEmail: payment.voidedByEmail,
        voidReason: payment.voidReason,
      })),
      credits: credits.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        amountCents: entry.amountCents,
        reason: entry.reason,
        staffEmail: entry.staffEmail,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Record money received, or a complimentary period.
   *
   * Where the paid time starts is decided here, not by whoever is typing: see
   * nextCoverageStart. The reason given is kept on the payment and in the
   * audit trail.
   */
  async recordPayment(
    staff: StaffIdentity,
    organizationId: string,
    input: RecordPaymentRequest,
  ): Promise<void> {
    const now = Date.now();
    const paidAt = new Date(input.paidAt);
    const creditApplied = input.creditAppliedCents ?? 0;

    if (paidAt.getTime() > now + DAY) {
      throw new BadRequestException('The payment date cannot be in the future');
    }
    if (input.method === 'COMPLIMENTARY' && input.amountCents > 0) {
      throw new BadRequestException('A complimentary period has no amount; choose how they paid');
    }
    if (input.method !== 'COMPLIMENTARY' && input.amountCents === 0 && creditApplied === 0) {
      throw new BadRequestException('Enter the amount received, or mark the period complimentary');
    }

    await this.prisma.withStaff(staff.userId, async (tx) => {
      const subscription = await this.lockAccount(tx, organizationId);

      if (creditApplied > 0) {
        const balance = await this.balanceOf(tx, organizationId);
        if (creditApplied > balance) {
          throw new BadRequestException(`This business has ${money(balance)} of credit`);
        }
      }

      const live = await tx.billingPayment.findMany({
        where: { organizationId, voidedAt: null },
        select: { coversUntil: true },
      });

      const coversFrom = nextCoverageStart(
        {
          effectiveStatus: effectiveSubscriptionStatus(subscription, now),
          trialEndsAt: subscription.trialEndsAt,
          paidThrough: paidThroughOf(live),
        },
        now,
      );
      const coversUntil = addBillingInterval(coversFrom, input.interval);

      const payment = await tx.billingPayment.create({
        data: {
          organizationId,
          amountCents: input.amountCents,
          creditAppliedCents: creditApplied,
          method: input.method,
          interval: input.interval,
          planKey: subscription.planKey,
          reference: input.reference || null,
          paidAt,
          coversFrom,
          coversUntil,
          recordedByUserId: staff.userId,
          recordedByEmail: staff.email,
          note: input.reason,
        },
      });

      if (creditApplied > 0) {
        await tx.billingCredit.create({
          data: {
            organizationId,
            kind: 'APPLIED',
            amountCents: -creditApplied,
            reason: 'Spent on a payment',
            paymentId: payment.id,
            staffUserId: staff.userId,
            staffEmail: staff.email,
          },
        });
      }

      await this.settle(tx, subscription, now);

      await recordStaffEvent(tx, staff, organizationId, 'payment.recorded', input.reason, {
        paymentId: payment.id,
        amountCents: input.amountCents,
        creditAppliedCents: creditApplied,
        method: input.method,
        interval: input.interval,
        coversFrom: coversFrom.toISOString(),
        coversUntil: coversUntil.toISOString(),
      });
    });
  }

  /**
   * Undo a payment recorded by mistake.
   *
   * Voided, never deleted: the record of what was entered and who took it
   * back stays. Credit spent on it comes back, and the paid time is worked out
   * again from the payments that remain.
   */
  async voidPayment(
    staff: StaffIdentity,
    organizationId: string,
    paymentId: string,
    reason: string,
  ): Promise<void> {
    const now = Date.now();

    await this.prisma.withStaff(staff.userId, async (tx) => {
      const subscription = await this.lockAccount(tx, organizationId);

      const payment = await tx.billingPayment.findFirst({
        where: { id: paymentId, organizationId },
      });
      if (!payment) throw new NotFoundException();
      if (payment.voidedAt) throw new BadRequestException('That payment is already voided');

      await tx.billingPayment.update({
        where: { id: paymentId },
        data: {
          voidedAt: new Date(now),
          voidedByUserId: staff.userId,
          voidedByEmail: staff.email,
          voidReason: reason,
        },
      });

      if (payment.creditAppliedCents > 0) {
        await tx.billingCredit.create({
          data: {
            organizationId,
            kind: 'RESTORED',
            amountCents: payment.creditAppliedCents,
            reason: 'Returned when the payment it was spent on was voided',
            paymentId,
            staffUserId: staff.userId,
            staffEmail: staff.email,
          },
        });
      }

      await this.settle(tx, subscription, now);

      await recordStaffEvent(tx, staff, organizationId, 'payment.voided', reason, {
        paymentId,
        amountCents: payment.amountCents,
        creditRestoredCents: payment.creditAppliedCents,
      });
    });
  }

  async grantCredit(
    staff: StaffIdentity,
    organizationId: string,
    amountCents: number,
    reason: string,
  ): Promise<void> {
    await this.prisma.withStaff(staff.userId, async (tx) => {
      await this.lockAccount(tx, organizationId);

      await tx.billingCredit.create({
        data: {
          organizationId,
          kind: 'GRANTED',
          amountCents,
          reason,
          staffUserId: staff.userId,
          staffEmail: staff.email,
        },
      });

      await recordStaffEvent(tx, staff, organizationId, 'credit.granted', reason, { amountCents });
    });
  }

  /** Take back credit given in error. Never more than the business holds. */
  async removeCredit(
    staff: StaffIdentity,
    organizationId: string,
    amountCents: number,
    reason: string,
  ): Promise<void> {
    await this.prisma.withStaff(staff.userId, async (tx) => {
      await this.lockAccount(tx, organizationId);

      const balance = await this.balanceOf(tx, organizationId);
      if (amountCents > balance) {
        throw new BadRequestException(`This business has ${money(balance)} of credit`);
      }

      await tx.billingCredit.create({
        data: {
          organizationId,
          kind: 'REMOVED',
          amountCents: -amountCents,
          reason,
          staffUserId: staff.userId,
          staffEmail: staff.email,
        },
      });

      await recordStaffEvent(tx, staff, organizationId, 'credit.removed', reason, { amountCents });
    });
  }

  /** Whether a business has ever paid (and not had it voided). A business that has is not on a trial. */
  async hasPaid(tx: TransactionClient, organizationId: string): Promise<boolean> {
    return (await tx.billingPayment.count({ where: { organizationId, voidedAt: null } })) > 0;
  }

  // -------------------------------------------------------------------------

  /**
   * Take the business's subscription row for the rest of the transaction.
   *
   * Everything that changes money for one business queues behind this, so a
   * balance read here is still true when the entry it justifies is written.
   * 404 for a business that does not exist, like every other staff route.
   */
  private async lockAccount(tx: TransactionClient, organizationId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM subscriptions WHERE organization_id = ${organizationId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundException();

    return tx.subscription.findUniqueOrThrow({
      where: { organizationId },
      include: { plan: true },
    });
  }

  private async balanceOf(tx: TransactionClient, organizationId: string): Promise<number> {
    const result = await tx.billingCredit.aggregate({
      where: { organizationId },
      _sum: { amountCents: true },
    });
    return result._sum.amountCents ?? 0;
  }

  /**
   * Make the subscription agree with the payments.
   *
   * Paid through the latest unvoided payment. With none left, a business goes
   * back to its trial if it had one (running out on the same day it always
   * would have), and otherwise to read-only: nothing was ever really paid.
   */
  private async settle(
    tx: TransactionClient,
    subscription: SubscriptionWithPlan,
    now: number,
  ): Promise<void> {
    const latest = await tx.billingPayment.findFirst({
      where: { organizationId: subscription.organizationId, voidedAt: null },
      orderBy: { coversUntil: 'desc' },
    });

    const where = { organizationId: subscription.organizationId };

    if (latest) {
      await tx.subscription.update({
        where,
        data: {
          status: 'ACTIVE',
          periodStartsAt: latest.coversFrom,
          periodEndsAt: latest.coversUntil,
          graceEndsAt: null,
          cancelledAt: null,
        },
      });
    } else if (subscription.trialEndsAt) {
      await tx.subscription.update({
        where,
        data: { status: 'TRIALING', periodEndsAt: subscription.trialEndsAt, graceEndsAt: null },
      });
    } else {
      await tx.subscription.update({
        where,
        data: { status: 'SUSPENDED', periodEndsAt: new Date(now), graceEndsAt: null },
      });
    }
  }
}
