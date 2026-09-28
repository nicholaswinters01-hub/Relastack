import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { billingSimulationEnabled, type ServerEnv } from '@platform/config';
import type { TenantContext, TransactionClient } from '@platform/db';
import {
  accessLevelFor,
  effectiveGraceEndsAt,
  effectiveSubscriptionStatus,
  monthlyCharge,
  paidThroughOf,
  type AccessLevel,
  type BillingAccount,
  type BillingEvent,
  type BillingSummary,
  type Plan,
  type Subscription,
  type SubscriptionStatus,
  EVENT_TYPES,
  planComparisonExtraSchema,
} from '@platform/shared';
import { z } from 'zod';
import { SERVER_ENV } from '../config.provider';
import { EventsService } from '../notifications/events.service';
import { PrismaService } from '../prisma/prisma.service';

/** Every organization starts here, so evaluation is not hobbled by packaging. */
const DEFAULT_PLAN_KEY = 'trial';

export interface ResolvedSubscription {
  planKey: string;
  status: SubscriptionStatus;
  accessLevel: AccessLevel;
  /** Modules the plan includes plus any purchased as add-ons. */
  entitledModules: Set<string>;
  maxLocations: number | null;
}

/**
 * Plans, subscriptions, and what a lapse does to access.
 *
 * The only place in the codebase that knows a price exists. Everything else
 * asks about entitlement.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  /**
   * Choosing a plan and the simulated events both make a business "paying"
   * with no money involved. While payments are recorded by staff, production
   * answers them as if they did not exist.
   */
  private assertSelfServe(): void {
    if (!billingSimulationEnabled(this.env)) throw new NotFoundException();
  }

  /**
   * The business's own view of its account: what it has paid, for how long,
   * and the credit it holds. Voided payments are left out, and so is anything
   * about who recorded a payment or why.
   */
  async getAccount(context: TenantContext): Promise<BillingAccount> {
    const { payments, credit } = await this.prisma.withTenant(context, async (tx) => ({
      payments: await tx.billingPayment.findMany({
        where: { organizationId: context.organizationId, voidedAt: null },
        orderBy: { paidAt: 'desc' },
      }),
      credit: await tx.billingCredit.aggregate({
        where: { organizationId: context.organizationId },
        _sum: { amountCents: true },
      }),
    }));

    const latest = [...payments].sort(
      (a, b) => b.coversUntil.getTime() - a.coversUntil.getTime(),
    )[0];

    return {
      selfServe: billingSimulationEnabled(this.env),
      paidThrough: paidThroughOf(payments)?.toISOString() ?? null,
      interval: latest?.interval ?? null,
      creditBalanceCents: credit._sum.amountCents ?? 0,
      payments: payments.map((payment) => ({
        id: payment.id,
        paidAt: payment.paidAt.toISOString(),
        amountCents: payment.amountCents,
        creditAppliedCents: payment.creditAppliedCents,
        method: payment.method,
        interval: payment.interval,
        coversFrom: payment.coversFrom.toISOString(),
        coversUntil: payment.coversUntil.toISOString(),
      })),
    };
  }

  /**
   * Subscribe a brand-new organization to a trial.
   *
   * Runs inside registration's transaction. Entitlement is derived from the
   * subscription, so an organization committed without one would resolve to no
   * modules at all and be locked out of its own account.
   */
  async createTrialForNewOrganization(
    tx: TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const plan = await tx.plan.findUnique({ where: { key: DEFAULT_PLAN_KEY } });

    if (!plan) {
      // Seeded by migration. Missing means the database is not migrated, which
      // should fail loudly rather than silently creating a broken account.
      throw new Error(`Default plan "${DEFAULT_PLAN_KEY}" is missing`);
    }

    const trialEndsAt = new Date(Date.now() + plan.trialDays * 24 * 60 * 60 * 1000);

    await tx.subscription.create({
      data: {
        organizationId,
        planKey: plan.key,
        status: 'TRIALING',
        periodStartsAt: new Date(),
        periodEndsAt: trialEndsAt,
        trialEndsAt,
      },
    });
  }

  /**
   * Everything entitlement needs, in one query.
   *
   * Called once per request. Note what it returns: a set of module keys and an
   * access level — not a plan name, not a price. Callers cannot branch on
   * commercial packaging even if they wanted to, which is what keeps Phase 6
   * from leaking into every module.
   */
  async resolveFor(context: TenantContext): Promise<ResolvedSubscription | null> {
    const subscription = await this.prisma.withTenant(context, (tx) =>
      tx.subscription.findUnique({
        where: { organizationId: context.organizationId },
        include: { plan: { include: { modules: true } }, addOns: true },
      }),
    );

    if (!subscription) return null;

    const status = this.effectiveStatus(subscription);

    const entitledModules = new Set<string>([
      ...subscription.plan.modules.map((entry) => entry.moduleKey),
      ...subscription.addOns.map((entry) => entry.moduleKey),
    ]);

    // Core is implicit regardless of plan. A packaging mistake must never lock
    // an organization out of its own account.
    entitledModules.add('core');

    return {
      planKey: subscription.planKey,
      status,
      accessLevel: accessLevelFor(status),
      entitledModules,
      maxLocations: subscription.plan.maxLocations,
    };
  }

  /**
   * The status the subscription has actually reached, accounting for time.
   *
   * A grace period that expired at 3am must take effect at 3am, not whenever a
   * background job next runs. Computing it on read means the clock is always
   * correct; the scheduled sweep in Phase 11 only persists what is already
   * true, so notifications can fire.
   */
  private effectiveStatus(
    subscription: Parameters<typeof effectiveSubscriptionStatus>[0],
  ): SubscriptionStatus {
    return effectiveSubscriptionStatus(subscription);
  }

  async getSubscription(context: TenantContext): Promise<Subscription> {
    const row = await this.prisma.withTenant(context, (tx) =>
      tx.subscription.findUnique({
        where: { organizationId: context.organizationId },
        include: { plan: true, addOns: true },
      }),
    );

    if (!row) throw new NotFoundException('No subscription found');

    const status = this.effectiveStatus(row);

    return {
      planKey: row.planKey,
      planName: row.plan.name,
      status,
      accessLevel: accessLevelFor(status),
      periodStartsAt: row.periodStartsAt.toISOString(),
      periodEndsAt: row.periodEndsAt.toISOString(),
      trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
      graceEndsAt: effectiveGraceEndsAt(row)?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      addOns: row.addOns.map((entry) => entry.moduleKey),
    };
  }

  /** Plans a customer can choose. Retired plans stay for existing subscribers. */
  async listPlans(): Promise<Plan[]> {
    // Not tenant-scoped: the price list is public information.
    const plans = await this.prisma.client.plan.findMany({
      where: { isPublic: true },
      include: { modules: true },
      orderBy: { basePriceCents: 'asc' },
    });

    return plans.map((plan) => ({
      key: plan.key,
      name: plan.name,
      description: plan.description,
      basePriceCents: plan.basePriceCents,
      perLocationPriceCents: plan.perLocationPriceCents,
      includedLocations: plan.includedLocations,
      maxLocations: plan.maxLocations,
      gracePeriodDays: plan.gracePeriodDays,
      trialDays: plan.trialDays,
      annualBillingMonths: plan.annualBillingMonths,
      modules: plan.modules.map((entry) => entry.moduleKey),
      comparisonExtras: z.array(planComparisonExtraSchema).catch([]).parse(plan.comparisonExtras),
    }));
  }

  /**
   * What the organization will be charged.
   *
   * Computed rather than stored, so a price change is reflected without a
   * migration or a backfill.
   */
  async getSummary(context: TenantContext): Promise<BillingSummary> {
    const { subscription, activeLocations, userCount } = await this.prisma.withTenant(
      context,
      async (tx) => ({
        subscription: await tx.subscription.findUnique({
          where: { organizationId: context.organizationId },
          include: { plan: true, addOns: true },
        }),
        activeLocations: await tx.location.count({
          where: { organizationId: context.organizationId, status: 'ACTIVE' },
        }),
        userCount: await tx.organizationMembership.count({
          where: { organizationId: context.organizationId },
        }),
      }),
    );

    if (!subscription) throw new NotFoundException('No subscription found');

    const { plan } = subscription;
    const { billableLocations, locationChargeCents, addOnChargeCents, totalCents } = monthlyCharge(
      plan,
      activeLocations,
      subscription.addOns.map((entry) => entry.priceCents),
    );

    return {
      activeLocations,
      includedLocations: plan.includedLocations,
      billableLocations,
      maxLocations: plan.maxLocations,
      basePriceCents: plan.basePriceCents,
      locationChargeCents,
      addOnChargeCents,
      totalCents,
      // Reported so the interface can state plainly that adding staff costs
      // nothing. The number is never an input to the total above.
      userCount,
    };
  }

  /**
   * Move to a different plan.
   *
   * Refuses a downgrade that the organization has already outgrown, naming the
   * number. Silently orphaning locations — or deleting them — would be a
   * destructive surprise triggered by a billing change.
   */
  async changePlan(context: TenantContext, planKey: string): Promise<Subscription> {
    this.assertSelfServe();

    const plan = await this.prisma.client.plan.findUnique({ where: { key: planKey } });
    if (!plan) throw new NotFoundException('Unknown plan');

    await this.prisma.withTenant(context, async (tx) => {
      const activeLocations = await tx.location.count({
        where: { organizationId: context.organizationId, status: 'ACTIVE' },
      });

      if (plan.maxLocations !== null && activeLocations > plan.maxLocations) {
        throw new BadRequestException(
          `${plan.name} allows ${plan.maxLocations} location${plan.maxLocations === 1 ? '' : 's'}, ` +
            `and you have ${activeLocations}. Deactivate some first.`,
        );
      }

      await tx.subscription.update({
        where: { organizationId: context.organizationId },
        data: {
          planKey: plan.key,
          // Choosing a plan ends the trial and clears any lapse: the customer
          // has just committed, so holding a past failure against them would
          // be wrong.
          status: 'ACTIVE',
          graceEndsAt: null,
          cancelledAt: null,
          trialEndsAt: null,
          periodStartsAt: new Date(),
          periodEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      // Add-ons for modules the new plan already includes are redundant, and
      // continuing to charge for them would be indefensible.
      const included = await tx.planModule.findMany({ where: { planKey: plan.key } });

      await tx.subscriptionAddOn.deleteMany({
        where: {
          organizationId: context.organizationId,
          moduleKey: { in: included.map((entry) => entry.moduleKey) },
        },
      });
    });

    this.logger.log(`Organization ${context.organizationId} moved to plan ${plan.key}`);

    return this.getSubscription(context);
  }

  /**
   * Apply a billing event.
   *
   * Stands in for provider webhooks until Phase 18. The transitions are the
   * part worth getting right and are identical whether the trigger is a mock
   * call or a real webhook, which is exactly why they live here rather than in
   * a provider adapter.
   */
  async applyEvent(context: TenantContext, event: BillingEvent): Promise<Subscription> {
    this.assertSelfServe();

    const current = await this.prisma.withTenant(context, (tx) =>
      tx.subscription.findUnique({
        where: { organizationId: context.organizationId },
        include: { plan: true },
      }),
    );

    if (!current) throw new NotFoundException('No subscription found');

    const now = new Date();
    let data: Record<string, unknown>;

    switch (event) {
      case 'payment_failed':
        // Grace begins. Access stays FULL — this is the whole point.
        data = {
          status: 'PAST_DUE',
          graceEndsAt: new Date(now.getTime() + current.plan.gracePeriodDays * 24 * 60 * 60 * 1000),
        };
        break;

      case 'payment_succeeded':
        data = {
          status: 'ACTIVE',
          graceEndsAt: null,
          trialEndsAt: null,
          periodStartsAt: now,
          periodEndsAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        };
        break;

      case 'grace_expired':
        // Persists what effectiveStatus already computes, so Phase 11 has a
        // state change to notify on.
        data = { status: 'SUSPENDED', graceEndsAt: now };
        break;

      case 'cancel':
        // Read-only, not gone: they must still be able to export their data.
        data = { status: 'CANCELLED', cancelledAt: now };
        break;

      case 'resume':
        data = { status: 'ACTIVE', cancelledAt: null, graceEndsAt: null };
        break;
    }

    await this.prisma.withTenant(context, async (tx) => {
      await tx.subscription.update({ where: { organizationId: context.organizationId }, data });

      // Money reaches the owner. Emitted with the status change so a failed
      // card cannot silently start a grace period nobody was told about.
      const notify =
        event === 'payment_failed'
          ? EVENT_TYPES.SUBSCRIPTION_PAST_DUE
          : event === 'grace_expired' || event === 'cancel'
            ? EVENT_TYPES.SUBSCRIPTION_READ_ONLY
            : null;

      if (notify) {
        await this.events.emit(tx, context.organizationId, notify, { event });
      }
    });

    this.logger.log(`Billing event "${event}" applied to ${context.organizationId}`);

    return this.getSubscription(context);
  }

  /**
   * Purchase a module the plan does not include.
   *
   * Priced at today's rate and stored on the row, so a later price change does
   * not silently reprice an existing customer.
   */
  async addAddOn(context: TenantContext, moduleKey: string, priceCents = 0): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const subscription = await tx.subscription.findUnique({
        where: { organizationId: context.organizationId },
      });

      if (!subscription) throw new NotFoundException('No subscription found');

      await tx.subscriptionAddOn.upsert({
        where: {
          subscriptionId_moduleKey: { subscriptionId: subscription.id, moduleKey },
        },
        create: {
          subscriptionId: subscription.id,
          moduleKey,
          priceCents,
          organizationId: context.organizationId,
        },
        update: {},
      });
    });
  }

  async removeAddOn(context: TenantContext, moduleKey: string): Promise<void> {
    await this.prisma.withTenant(context, (tx) =>
      tx.subscriptionAddOn.deleteMany({
        where: { organizationId: context.organizationId, moduleKey },
      }),
    );
  }
}
