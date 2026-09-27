import { z } from 'zod';
import type { SubscriptionStatus } from './subscription';

/**
 * Billing by hand (Phase 19b).
 *
 * Until Phase 18 connects a payment provider, staff record the money a business
 * pays. A payment covers a stretch of time, monthly or annual; the business is
 * paid through the end of the latest one. Credit is a ledger, and its balance
 * is always the sum of the entries, never a stored number that could drift.
 *
 * The arithmetic lives here, pure, so the API and its tests share one answer.
 */

export const billingIntervalSchema = z.enum(['MONTHLY', 'ANNUAL']);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

export const paymentMethodSchema = z.enum([
  'CARD',
  'BANK_TRANSFER',
  'CHECK',
  'CASH',
  'COMPLIMENTARY',
  'OTHER',
]);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const creditKindSchema = z.enum(['GRANTED', 'APPLIED', 'RESTORED', 'REMOVED']);
export type CreditKind = z.infer<typeof creditKindSchema>;

const DAY = 24 * 60 * 60 * 1000;

/**
 * One month or one year on, by the calendar.
 *
 * Calendar rather than 30 or 365 days, so a business paying on the 15th stays
 * due on the 15th. A day the target month lacks becomes its last day: paid on
 * 31 January, covered to 28 (or 29) February, not into March.
 */
export function addBillingInterval(from: Date, interval: BillingInterval): Date {
  const months = interval === 'ANNUAL' ? 12 : 1;
  const result = new Date(from.getTime());
  const day = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));

  return result;
}

/**
 * When a newly recorded payment's coverage should begin.
 *
 *   - During a trial: when the trial ends. Paying early must not cost them the
 *     trial days they were promised.
 *   - While paid, or in the grace period after: where the last payment ended,
 *     so renewals line up and grace days are not given away twice.
 *   - Otherwise (read-only, or never paid): now. Nobody pays for the months
 *     they spent unable to change anything.
 */
export function nextCoverageStart(
  input: {
    effectiveStatus: SubscriptionStatus;
    trialEndsAt: Date | null;
    paidThrough: Date | null;
  },
  now: number = Date.now(),
): Date {
  const { effectiveStatus, trialEndsAt, paidThrough } = input;

  if (effectiveStatus === 'TRIALING' && trialEndsAt && trialEndsAt.getTime() > now) {
    return trialEndsAt;
  }

  if ((effectiveStatus === 'ACTIVE' || effectiveStatus === 'PAST_DUE') && paidThrough) {
    return paidThrough;
  }

  return new Date(now);
}

export interface CoveringPayment {
  amountCents: number;
  creditAppliedCents: number;
  coversFrom: Date;
  coversUntil: Date;
}

/**
 * How much of what a business has paid is still unused.
 *
 * Straight-line by time over each payment's own period, counting credit spent
 * as money paid. A period not yet started is wholly unused; one already over
 * is worth nothing. This is what an annual customer who leaves in month four
 * has left, and what a refund or a credit would be based on.
 */
export function unusedValue(
  payments: CoveringPayment[],
  now: number = Date.now(),
): { unusedCents: number; paidCents: number } {
  let unusedCents = 0;
  let paidCents = 0;

  for (const payment of payments) {
    const from = payment.coversFrom.getTime();
    const until = payment.coversUntil.getTime();
    const value = payment.amountCents + payment.creditAppliedCents;

    if (until <= now) continue;

    paidCents += value;
    const remaining = until - Math.max(now, from);
    unusedCents += Math.round((value * remaining) / (until - from));
  }

  return { unusedCents, paidCents };
}

/** Whole days until a moment, rounded up: "paid through tomorrow noon" is one day left. */
export function daysUntil(moment: Date, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((moment.getTime() - now) / DAY));
}

export function creditBalance(entries: Array<{ amountCents: number }>): number {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}

/** The latest moment any unvoided payment covers, or null if nothing has been paid. */
export function paidThroughOf(payments: Array<{ coversUntil: Date }>): Date | null {
  let latest: Date | null = null;

  for (const payment of payments) {
    if (!latest || payment.coversUntil > latest) latest = payment.coversUntil;
  }

  return latest;
}

/** What a business sees of its own payments. Never who recorded them or why. */
export const accountPaymentSchema = z.object({
  id: z.string().uuid(),
  paidAt: z.string().datetime(),
  amountCents: z.number().int().nonnegative(),
  creditAppliedCents: z.number().int().nonnegative(),
  method: paymentMethodSchema,
  interval: billingIntervalSchema,
  coversFrom: z.string().datetime(),
  coversUntil: z.string().datetime(),
});
export type AccountPayment = z.infer<typeof accountPaymentSchema>;

/** The business's own view of its account with us. */
export const billingAccountSchema = z.object({
  /**
   * Whether the business can choose a plan and pay by itself. False while
   * payments are recorded by hand; the page then says how to reach us.
   */
  selfServe: z.boolean(),
  paidThrough: z.string().datetime().nullable(),
  interval: billingIntervalSchema.nullable(),
  creditBalanceCents: z.number().int(),
  payments: z.array(accountPaymentSchema),
});
export type BillingAccount = z.infer<typeof billingAccountSchema>;
