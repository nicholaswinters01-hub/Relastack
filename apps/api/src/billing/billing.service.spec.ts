import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from './billing.service';

/**
 * The lapse clock and the price arithmetic.
 *
 * Both are pure enough to test without a database, and both are the kind of
 * thing that is quietly wrong for months: a grace period off by a day, or a
 * total that charges for included locations.
 */

const TENANT = {
  organizationId: '22222222-2222-4222-8222-222222222222',
  userId: '11111111-1111-4111-8111-111111111111',
};

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

const BUSINESS = {
  key: 'business',
  name: 'Business',
  description: 'Multiple locations.',
  basePriceCents: 7900,
  perLocationPriceCents: 1500,
  includedLocations: 3,
  maxLocations: null as number | null,
  gracePeriodDays: 14,
  trialDays: 14,
  isPublic: true,
  modules: [{ moduleKey: 'core' }, { moduleKey: 'crm' }, { moduleKey: 'scheduling' }],
};

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    organizationId: TENANT.organizationId,
    planKey: 'business',
    status: 'ACTIVE',
    periodStartsAt: ago(DAY),
    periodEndsAt: ahead(29 * DAY),
    trialEndsAt: null,
    graceEndsAt: null,
    cancelledAt: null,
    plan: BUSINESS,
    addOns: [],
    ...overrides,
  };
}

describe('BillingService', () => {
  let findUnique: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let locationCount: ReturnType<typeof vi.fn>;
  let membershipCount: ReturnType<typeof vi.fn>;
  let planFindUnique: ReturnType<typeof vi.fn>;
  let service: BillingService;

  beforeEach(async () => {
    findUnique = vi.fn().mockResolvedValue(makeSubscription());
    update = vi.fn().mockResolvedValue(makeSubscription());
    locationCount = vi.fn().mockResolvedValue(0);
    membershipCount = vi.fn().mockResolvedValue(12);
    planFindUnique = vi.fn().mockResolvedValue(BUSINESS);

    const tx = {
      subscription: { findUnique, update },
      location: { count: locationCount },
      organizationMembership: { count: membershipCount },
      planModule: { findMany: vi.fn().mockResolvedValue(BUSINESS.modules) },
      subscriptionAddOn: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BillingService,
        {
          provide: PrismaService,
          useValue: {
            withTenant: vi.fn().mockImplementation((_c, work) => work(tx)),
            client: { plan: { findUnique: planFindUnique, findMany: vi.fn() } },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(BillingService);
  });

  // -------------------------------------------------------------------------

  describe('the grace period', () => {
    it('keeps FULL access while a failed payment is being chased', async () => {
      findUnique.mockResolvedValue(
        makeSubscription({ status: 'PAST_DUE', graceEndsAt: ahead(10 * DAY) }),
      );

      const resolved = await service.resolveFor(TENANT);

      // The single most important assertion in this file. A landscaping
      // company must not lose their schedule mid-job because a card expired.
      expect(resolved?.status).toBe('PAST_DUE');
      expect(resolved?.accessLevel).toBe('full');
    });

    it('narrows to read-only the moment grace expires, without waiting for a job', async () => {
      findUnique.mockResolvedValue(
        makeSubscription({ status: 'PAST_DUE', graceEndsAt: ago(1000) }),
      );

      const resolved = await service.resolveFor(TENANT);

      // Computed on read. A sweep that runs hourly would leave a customer with
      // free access until the next tick, and a customer who paid at 3:01am
      // locked out until 4am.
      expect(resolved?.status).toBe('SUSPENDED');
      expect(resolved?.accessLevel).toBe('read-only');
    });

    it('treats the exact expiry instant as expired', async () => {
      const instant = new Date();
      vi.setSystemTime(instant);
      findUnique.mockResolvedValue(makeSubscription({ status: 'PAST_DUE', graceEndsAt: instant }));

      expect((await service.resolveFor(TENANT))?.status).toBe('SUSPENDED');

      vi.useRealTimers();
    });

    it('ignores a grace date on a subscription that is not past due', async () => {
      // A stale grace_ends_at left over from a lapse the customer already
      // fixed must not suspend a paying account.
      findUnique.mockResolvedValue(
        makeSubscription({ status: 'ACTIVE', graceEndsAt: ago(30 * DAY) }),
      );

      expect((await service.resolveFor(TENANT))?.accessLevel).toBe('full');
    });

    it('expires a trial the same way', async () => {
      findUnique.mockResolvedValue(
        makeSubscription({ status: 'TRIALING', trialEndsAt: ago(1000) }),
      );

      const resolved = await service.resolveFor(TENANT);

      // Read-only, not gone. They can still see what they built during the
      // trial, which is the reason to subscribe.
      expect(resolved?.accessLevel).toBe('read-only');
    });

    it('leaves a running trial alone', async () => {
      findUnique.mockResolvedValue(
        makeSubscription({ status: 'TRIALING', trialEndsAt: ahead(3 * DAY) }),
      );

      expect((await service.resolveFor(TENANT))?.accessLevel).toBe('full');
    });
  });

  // -------------------------------------------------------------------------

  describe('resolved entitlement', () => {
    it('returns module keys and an access level — never a price or a plan name to branch on', async () => {
      const resolved = await service.resolveFor(TENANT);

      // What callers CANNOT see is the point. Nothing downstream can branch on
      // packaging even if a future author wanted to.
      expect(Object.keys(resolved!).sort()).toEqual(
        ['accessLevel', 'entitledModules', 'maxLocations', 'planKey', 'status'].sort(),
      );
      expect(resolved).not.toHaveProperty('basePriceCents');
    });

    it('unions plan modules with purchased add-ons', async () => {
      findUnique.mockResolvedValue(
        makeSubscription({ addOns: [{ moduleKey: 'inventory', priceCents: 900 }] }),
      );

      const resolved = await service.resolveFor(TENANT);

      expect([...resolved!.entitledModules].sort()).toEqual([
        'core',
        'crm',
        'inventory',
        'scheduling',
      ]);
    });

    it('always grants core, whatever the plan says', async () => {
      findUnique.mockResolvedValue(makeSubscription({ plan: { ...BUSINESS, modules: [] } }));

      // A packaging mistake must never lock an organization out of its own
      // account settings or its billing page.
      expect((await service.resolveFor(TENANT))?.entitledModules.has('core')).toBe(true);
    });

    it('grants core even to a suspended account', async () => {
      findUnique.mockResolvedValue(makeSubscription({ status: 'SUSPENDED' }));

      const resolved = await service.resolveFor(TENANT);

      // Read-only is enforced separately. Entitlement must not ALSO strip
      // core, or a lapsed customer could not reach the page that fixes it.
      expect(resolved?.entitledModules.has('core')).toBe(true);
      expect(resolved?.accessLevel).toBe('read-only');
    });

    it('returns null when there is no subscription rather than inventing one', async () => {
      findUnique.mockResolvedValue(null);

      expect(await service.resolveFor(TENANT)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  describe('what the organization is charged', () => {
    it('charges base only while within the included locations', async () => {
      locationCount.mockResolvedValue(3);

      const summary = await service.getSummary(TENANT);

      expect(summary.billableLocations).toBe(0);
      expect(summary.totalCents).toBe(7900);
    });

    it('charges per location beyond those included', async () => {
      locationCount.mockResolvedValue(5);

      const summary = await service.getSummary(TENANT);

      expect(summary.billableLocations).toBe(2);
      expect(summary.locationChargeCents).toBe(3000);
      expect(summary.totalCents).toBe(7900 + 3000);
    });

    it('never goes negative below the included count', async () => {
      locationCount.mockResolvedValue(1);

      const summary = await service.getSummary(TENANT);

      // Fewer locations than included is a discount nobody offered.
      expect(summary.billableLocations).toBe(0);
      expect(summary.totalCents).toBe(7900);
    });

    it('adds add-ons at the price stored on the row', async () => {
      locationCount.mockResolvedValue(3);
      findUnique.mockResolvedValue(
        makeSubscription({ addOns: [{ moduleKey: 'inventory', priceCents: 900 }] }),
      );

      const summary = await service.getSummary(TENANT);

      // Stored, not looked up, so raising the list price does not silently
      // reprice an existing customer.
      expect(summary.addOnChargeCents).toBe(900);
      expect(summary.totalCents).toBe(7900 + 900);
    });

    it('does not charge by user, however many there are', async () => {
      locationCount.mockResolvedValue(3);
      membershipCount.mockResolvedValue(400);

      const summary = await service.getSummary(TENANT);

      // The commercial promise: unlimited users. Reported, never multiplied.
      expect(summary.userCount).toBe(400);
      expect(summary.totalCents).toBe(7900);
    });
  });

  // -------------------------------------------------------------------------

  describe('changing plan', () => {
    it('rejects an unknown plan', async () => {
      planFindUnique.mockResolvedValue(null);

      await expect(service.changePlan(TENANT, 'platinum')).rejects.toThrow(NotFoundException);
    });

    it('refuses a downgrade the organization has outgrown, naming the number', async () => {
      planFindUnique.mockResolvedValue({
        ...BUSINESS,
        key: 'starter',
        name: 'Starter',
        maxLocations: 1,
      });
      locationCount.mockResolvedValue(4);

      // Silently deactivating three locations because of a billing click would
      // be a destructive surprise.
      await expect(service.changePlan(TENANT, 'starter')).rejects.toThrow(
        /Starter allows 1 location, and you have 4/,
      );
      await expect(service.changePlan(TENANT, 'starter')).rejects.toThrow(BadRequestException);
      expect(update).not.toHaveBeenCalled();
    });

    it('allows a downgrade that exactly fits', async () => {
      planFindUnique.mockResolvedValue({ ...BUSINESS, key: 'starter', maxLocations: 1 });
      locationCount.mockResolvedValue(1);

      await service.changePlan(TENANT, 'starter');

      expect(update).toHaveBeenCalled();
    });

    it('clears a past lapse, because the customer has just committed', async () => {
      locationCount.mockResolvedValue(0);

      await service.changePlan(TENANT, 'business');

      const { data } = update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(data.status).toBe('ACTIVE');
      expect(data.graceEndsAt).toBeNull();
      expect(data.cancelledAt).toBeNull();
      expect(data.trialEndsAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  describe('billing events', () => {
    it('opens a grace window the length the plan promises', async () => {
      await service.applyEvent(TENANT, 'payment_failed');

      const { data } = update.mock.calls[0]?.[0] as { data: { status: string; graceEndsAt: Date } };
      expect(data.status).toBe('PAST_DUE');

      const days = Math.round((data.graceEndsAt.getTime() - Date.now()) / DAY);
      expect(days).toBe(BUSINESS.gracePeriodDays);
    });

    it('restores full access on payment', async () => {
      await service.applyEvent(TENANT, 'payment_succeeded');

      const { data } = update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(data.status).toBe('ACTIVE');
      expect(data.graceEndsAt).toBeNull();
    });

    it('cancels without deleting anything', async () => {
      await service.applyEvent(TENANT, 'cancel');

      const { data } = update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(data.status).toBe('CANCELLED');
      // No destructive field anywhere: their data outlives the subscription.
      expect(Object.keys(data)).toEqual(['status', 'cancelledAt']);
    });

    it('refuses to act on an organization with no subscription', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.applyEvent(TENANT, 'cancel')).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------

  describe('a brand-new organization', () => {
    it('is subscribed to a trial inside the caller transaction', async () => {
      const create = vi.fn();
      const tx = {
        plan: {
          findUnique: vi.fn().mockResolvedValue({ ...BUSINESS, key: 'trial', trialDays: 14 }),
        },
        subscription: { create },
      };

      await service.createTrialForNewOrganization(tx as never, TENANT.organizationId);

      const { data } = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(data.planKey).toBe('trial');
      expect(data.status).toBe('TRIALING');
    });

    it('fails loudly when the default plan is missing', async () => {
      const tx = { plan: { findUnique: vi.fn().mockResolvedValue(null) }, subscription: {} };

      // An organization committed without a subscription resolves to no
      // modules and is locked out of its own account. Better to fail
      // registration than to create that.
      await expect(
        service.createTrialForNewOrganization(tx as never, TENANT.organizationId),
      ).rejects.toThrow(/Default plan "trial" is missing/);
    });
  });
});
