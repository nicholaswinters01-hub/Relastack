import { z } from 'zod';

/**
 * Plans, subscriptions and add-ons.
 *
 * Four concepts kept apart on purpose (docs/adr/0003):
 *
 *   Module        a capability the software has
 *   Plan          a commercial package that includes some modules
 *   Subscription  what one organization currently pays for
 *   Entitlement   the resolved answer to "may they use this, right now?"
 *
 * Business logic asks only the fourth. Nothing outside the billing service
 * reads a price or branches on a plan name.
 */

export const subscriptionStatusSchema = z.enum([
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
]);

export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/**
 * How much of the product a status allows.
 *
 * Three bands rather than on/off. The middle one is the grace period: a failed
 * card must not lock a landscaping company out mid-job, so PAST_DUE keeps full
 * access while the customer is chased. Only afterwards does access narrow to
 * read-only — and never to nothing, because someone who cannot reach their own
 * data cannot decide to come back.
 */
export type AccessLevel = 'full' | 'read-only';

export const ACCESS_BY_STATUS: Record<SubscriptionStatus, AccessLevel> = {
  TRIALING: 'full',
  ACTIVE: 'full',
  PAST_DUE: 'full',
  SUSPENDED: 'read-only',
  CANCELLED: 'read-only',
};

export function accessLevelFor(status: SubscriptionStatus): AccessLevel {
  return ACCESS_BY_STATUS[status];
}

/**
 * The status a subscription is really in, now.
 *
 * A lapsed grace period or trial becomes read-only the moment it lapses, not
 * whenever a background job next runs. Computed on read so the clock is
 * always right; the hourly sweep only persists what is already true.
 */
export function effectiveSubscriptionStatus(
  subscription: { status: SubscriptionStatus; graceEndsAt: Date | null; trialEndsAt: Date | null },
  now: number = Date.now(),
): SubscriptionStatus {
  if (subscription.status === 'PAST_DUE' && subscription.graceEndsAt) {
    if (subscription.graceEndsAt.getTime() <= now) return 'SUSPENDED';
  }

  if (subscription.status === 'TRIALING' && subscription.trialEndsAt) {
    // An expired trial becomes read-only rather than vanishing, so the
    // customer can still reach their data and decide to subscribe.
    if (subscription.trialEndsAt.getTime() <= now) return 'SUSPENDED';
  }

  return subscription.status;
}

/**
 * What a business is charged per month: the plan, locations beyond those
 * included, and add-ons. Never the number of users.
 */
export function monthlyCharge(
  plan: { basePriceCents: number; perLocationPriceCents: number; includedLocations: number },
  activeLocations: number,
  addOnPricesCents: number[],
): {
  billableLocations: number;
  locationChargeCents: number;
  addOnChargeCents: number;
  totalCents: number;
} {
  const billableLocations = Math.max(0, activeLocations - plan.includedLocations);
  const locationChargeCents = billableLocations * plan.perLocationPriceCents;
  const addOnChargeCents = addOnPricesCents.reduce((sum, cents) => sum + cents, 0);

  return {
    billableLocations,
    locationChargeCents,
    addOnChargeCents,
    totalCents: plan.basePriceCents + locationChargeCents + addOnChargeCents,
  };
}

export const planSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  basePriceCents: z.number().int().nonnegative(),
  perLocationPriceCents: z.number().int().nonnegative(),
  includedLocations: z.number().int().nonnegative(),
  maxLocations: z.number().int().positive().nullable(),
  gracePeriodDays: z.number().int().nonnegative(),
  trialDays: z.number().int().nonnegative(),
  /** Module keys included at no extra charge. */
  modules: z.array(z.string()),
});

export type Plan = z.infer<typeof planSchema>;

export const subscriptionSchema = z.object({
  planKey: z.string(),
  planName: z.string(),
  status: subscriptionStatusSchema,
  /** Derived from status. Sent so the interface can explain itself. */
  accessLevel: z.enum(['full', 'read-only']),
  periodStartsAt: z.string().datetime(),
  periodEndsAt: z.string().datetime(),
  trialEndsAt: z.string().datetime().nullable(),
  /** When full access ends and read-only begins, if a payment has failed. */
  graceEndsAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  /** Module keys purchased beyond the plan. */
  addOns: z.array(z.string()),
});

export type Subscription = z.infer<typeof subscriptionSchema>;

/**
 * What the organization will be charged, and what it is allowed.
 *
 * Computed rather than stored, so a plan price change is reflected without a
 * migration. Phase 18 reconciles this against the payment provider.
 */
export const billingSummarySchema = z.object({
  activeLocations: z.number().int().nonnegative(),
  includedLocations: z.number().int().nonnegative(),
  billableLocations: z.number().int().nonnegative(),
  maxLocations: z.number().int().positive().nullable(),
  basePriceCents: z.number().int().nonnegative(),
  locationChargeCents: z.number().int().nonnegative(),
  addOnChargeCents: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  /** Users are never a billing input. Present so the UI can say so. */
  userCount: z.number().int().nonnegative(),
});

export type BillingSummary = z.infer<typeof billingSummarySchema>;

export const subscriptionResponseSchema = z.object({
  subscription: subscriptionSchema,
  summary: billingSummarySchema,
});

export type SubscriptionResponse = z.infer<typeof subscriptionResponseSchema>;

export const plansResponseSchema = z.object({ plans: z.array(planSchema) });
export type PlansResponse = z.infer<typeof plansResponseSchema>;

export const changePlanRequestSchema = z.object({ planKey: z.string().min(1) });
export type ChangePlanRequest = z.infer<typeof changePlanRequestSchema>;

/** Error body when a write is refused because access is read-only. */
export const readOnlySchema = z.object({
  statusCode: z.literal(403),
  code: z.literal('SUBSCRIPTION_READ_ONLY'),
  status: subscriptionStatusSchema,
  message: z.string(),
});

/** Error body when an action would exceed the plan's location allowance. */
export const locationLimitSchema = z.object({
  statusCode: z.literal(403),
  code: z.literal('LOCATION_LIMIT_REACHED'),
  maxLocations: z.number().int().positive(),
  message: z.string(),
});

/**
 * Development-only billing events.
 *
 * Phase 18 replaces these with provider webhooks. They exist now so the
 * lapse-and-recover path can be exercised end to end without a payment
 * provider — the transitions are the part worth getting right, and they are
 * identical either way.
 */
export const billingEventSchema = z.enum([
  'payment_failed',
  'payment_succeeded',
  'grace_expired',
  'cancel',
  'resume',
]);

export type BillingEvent = z.infer<typeof billingEventSchema>;

export const billingEventRequestSchema = z.object({ event: billingEventSchema });
export type BillingEventRequest = z.infer<typeof billingEventRequestSchema>;
