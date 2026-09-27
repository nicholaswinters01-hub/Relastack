import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ServerEnv } from '@platform/config';
import type { Prisma, TransactionClient } from '@platform/db';
import {
  accessLevelFor,
  effectiveGraceEndsAt,
  effectiveSubscriptionStatus,
  monthlyCharge,
  type StaffAuditEvent,
  type StaffBusinessDetail,
  type StaffBusinessQuery,
  type StaffBusinessSummary,
  type StaffOverview,
  type SubscriptionStatus,
} from '@platform/shared';
import { SERVER_ENV } from '../config.provider';
import {
  hashInvitationToken,
  INVITATION_TTL_DAYS,
  TOKEN_BYTES,
} from '../invitations/invitations.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaffBillingService } from './staff-billing.service';
import { recordStaffEvent, toAuditEvent } from './staff-audit';
import type { StaffIdentity } from './staff.decorators';

const DAY = 24 * 60 * 60 * 1000;
const MAX_TRIAL_EXTENSION = 366 * DAY;
/** A second look at the same business within this window is the same visit. */
const VIEW_LOG_WINDOW = 30 * 60 * 1000;
/** Paid time running out within this window is a renewal to chase. */
const RENEWAL_WINDOW = 30 * DAY;

/**
 * The staff console.
 *
 * Everything runs through withStaff, which the database limits to account
 * information. There is no withTenant anywhere in this file, and that is the
 * point: acting AS a business would unlock everything it owns, including its
 * customers, which staff have promised not to see.
 *
 * Every look at a business and every change is written to the audit trail, in
 * the same transaction as the change itself, so there is never a change
 * without its record.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: StaffBillingService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  // -------------------------------------------------------------------------
  // Reading

  async overview(staff: StaffIdentity): Promise<StaffOverview> {
    const now = Date.now();

    const { organizations, collected, credit, openSupport } = await this.prisma.withStaff(
      staff.userId,
      async (tx) => ({
        organizations: await tx.organization.findMany({
          select: {
            status: true,
            subscription: { include: { plan: true, addOns: true } },
            _count: { select: { locations: { where: { status: 'ACTIVE' } } } },
          },
        }),
        collected: await tx.billingPayment.aggregate({
          where: { voidedAt: null, paidAt: { gte: new Date(now - 30 * DAY) } },
          _sum: { amountCents: true },
        }),
        credit: await tx.billingCredit.aggregate({ _sum: { amountCents: true } }),
        openSupport: await tx.supportRequest.count({ where: { status: 'OPEN' } }),
      }),
    );

    const overview: StaffOverview = {
      businesses: organizations.length,
      trialing: 0,
      trialsEndingThisWeek: 0,
      paying: 0,
      pastDue: 0,
      readOnly: 0,
      suspended: 0,
      estimatedMonthlyRevenueCents: 0,
      renewalsDueSoon: 0,
      collectedLast30DaysCents: collected._sum.amountCents ?? 0,
      creditOutstandingCents: Math.max(0, credit._sum.amountCents ?? 0),
      openSupportRequests: openSupport,
    };

    for (const organization of organizations) {
      if (organization.status === 'SUSPENDED') overview.suspended += 1;

      const subscription = organization.subscription;
      if (!subscription) continue;

      const status = effectiveSubscriptionStatus(subscription, now);

      if (status === 'TRIALING') {
        overview.trialing += 1;
        if (subscription.trialEndsAt && subscription.trialEndsAt.getTime() - now <= 7 * DAY) {
          overview.trialsEndingThisWeek += 1;
        }
      }
      if (status === 'ACTIVE') {
        overview.paying += 1;
        if (subscription.periodEndsAt.getTime() - now <= RENEWAL_WINDOW) {
          overview.renewalsDueSoon += 1;
        }
      }
      if (status === 'PAST_DUE') overview.pastDue += 1;
      if (accessLevelFor(status) === 'read-only') overview.readOnly += 1;

      // Revenue is what paying businesses are charged, grace period included.
      if (status === 'ACTIVE' || status === 'PAST_DUE') {
        overview.estimatedMonthlyRevenueCents += monthlyCharge(
          subscription.plan,
          organization._count.locations,
          subscription.addOns.map((entry) => entry.priceCents),
        ).totalCents;
      }
    }

    return overview;
  }

  async listBusinesses(
    staff: StaffIdentity,
    query: StaffBusinessQuery,
  ): Promise<StaffBusinessSummary[]> {
    const search = query.search?.trim();
    const where: Prisma.OrganizationWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { memberships: { some: { user: { email: { contains: search } } } } },
          ],
        }
      : {};

    const rows = await this.prisma.withStaff(staff.userId, async (tx) => {
      const found = await tx.organization.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          subscription: { include: { plan: true } },
          _count: { select: { locations: { where: { status: 'ACTIVE' } }, memberships: true } },
          memberships: {
            select: {
              role: true,
              user: {
                select: {
                  email: true,
                  lastLoginAt: true,
                  sessions: {
                    select: { lastUsedAt: true },
                    orderBy: { lastUsedAt: 'desc' },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });

      await recordStaffEvent(tx, staff, null, 'businesses.listed', null, {
        search: search ?? null,
        filter: query.filter,
        results: found.length,
      });

      return found;
    });

    const now = Date.now();

    const summaries = rows.map(
      (row): StaffBusinessSummary & { effective: SubscriptionStatus | null } => {
        const effective = row.subscription
          ? effectiveSubscriptionStatus(row.subscription, now)
          : null;
        const owner = row.memberships.find((m) => m.role === 'OWNER');

        const activity = row.memberships.flatMap((m) => [
          m.user.lastLoginAt?.getTime() ?? 0,
          m.user.sessions[0]?.lastUsedAt.getTime() ?? 0,
        ]);
        const lastActive = Math.max(0, ...activity);

        return {
          id: row.id,
          name: row.name,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          planName: row.subscription?.plan.name ?? null,
          subscriptionStatus: effective,
          trialEndsAt: row.subscription?.trialEndsAt?.toISOString() ?? null,
          paidThrough:
            row.subscription && (effective === 'ACTIVE' || effective === 'PAST_DUE')
              ? row.subscription.periodEndsAt.toISOString()
              : null,
          locationCount: row._count.locations,
          memberCount: row._count.memberships,
          ownerEmail: owner?.user.email ?? null,
          lastActiveAt: lastActive > 0 ? new Date(lastActive).toISOString() : null,
          effective,
        };
      },
    );

    const matches = (s: (typeof summaries)[number]): boolean => {
      switch (query.filter) {
        case 'trialing':
          return s.effective === 'TRIALING';
        case 'trial-ending':
          return (
            s.effective === 'TRIALING' &&
            s.trialEndsAt !== null &&
            new Date(s.trialEndsAt).getTime() - now <= 7 * DAY
          );
        case 'renewal-due':
          return (
            s.effective === 'ACTIVE' &&
            s.paidThrough !== null &&
            new Date(s.paidThrough).getTime() - now <= RENEWAL_WINDOW
          );
        case 'past-due':
          return s.effective === 'PAST_DUE';
        case 'read-only':
          return s.effective !== null && accessLevelFor(s.effective) === 'read-only';
        case 'suspended':
          return s.status === 'SUSPENDED';
        default:
          return true;
      }
    };

    return summaries.filter(matches).map(({ effective: _effective, ...summary }) => summary);
  }

  async businessDetail(staff: StaffIdentity, organizationId: string): Promise<StaffBusinessDetail> {
    return this.prisma.withStaff(staff.userId, async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        include: {
          subscription: { include: { plan: true, addOns: true } },
          locations: { orderBy: { name: 'asc' } },
          memberships: { include: { user: true }, orderBy: { createdAt: 'asc' } },
        },
      });

      if (!organization) throw new NotFoundException();

      // One entry per visit, not per page load: every action refreshes the
      // page, and logging each refresh buried the actions themselves.
      const recentLook = await tx.staffAuditEvent.findFirst({
        where: {
          organizationId,
          staffUserId: staff.userId,
          action: 'business.viewed',
          createdAt: { gt: new Date(Date.now() - VIEW_LOG_WINDOW) },
        },
        select: { id: true },
      });
      if (!recentLook)
        await recordStaffEvent(tx, staff, organizationId, 'business.viewed', null, {});

      const userIds = organization.memberships.map((m) => m.userId);
      const now = new Date();

      const [sessionCounts, modules, invitations, notes, activity, plans] = await Promise.all([
        tx.session.groupBy({
          by: ['userId'],
          where: { userId: { in: userIds }, revokedAt: null, expiresAt: { gt: now } },
          _count: { _all: true },
        }),
        tx.organizationModule.findMany({
          where: { organizationId },
          orderBy: { moduleKey: 'asc' },
        }),
        tx.invitation.findMany({
          where: { organizationId },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        tx.staffNote.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' } }),
        tx.staffAuditEvent.findMany({
          where: { organizationId },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
        tx.plan.findMany({ orderBy: { basePriceCents: 'asc' } }),
      ]);

      const sessionsFor = new Map(sessionCounts.map((row) => [row.userId, row._count._all]));
      const subscription = organization.subscription;
      const activeLocations = organization.locations.filter((l) => l.status === 'ACTIVE').length;
      const billing = await this.billing.billingFor(
        tx,
        organizationId,
        subscription,
        activeLocations,
        now.getTime(),
      );

      return {
        business: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          status: organization.status,
          createdAt: organization.createdAt.toISOString(),
        },
        subscription: subscription
          ? (() => {
              const effectiveStatus = effectiveSubscriptionStatus(subscription);
              return {
                planKey: subscription.planKey,
                planName: subscription.plan.name,
                status: subscription.status,
                effectiveStatus,
                accessLevel: accessLevelFor(effectiveStatus),
                trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
                periodStartsAt: subscription.periodStartsAt.toISOString(),
                periodEndsAt: subscription.periodEndsAt.toISOString(),
                graceEndsAt: effectiveGraceEndsAt(subscription)?.toISOString() ?? null,
                cancelledAt: subscription.cancelledAt?.toISOString() ?? null,
                monthlyChargeCents: monthlyCharge(
                  subscription.plan,
                  activeLocations,
                  subscription.addOns.map((entry) => entry.priceCents),
                ).totalCents,
                addOns: subscription.addOns.map((entry) => ({
                  moduleKey: entry.moduleKey,
                  priceCents: entry.priceCents,
                })),
              };
            })()
          : null,
        locations: organization.locations.map((location) => ({
          id: location.id,
          name: location.name,
          city: location.city,
          region: location.region,
          status: location.status,
        })),
        members: organization.memberships.map((membership) => ({
          userId: membership.userId,
          email: membership.user.email,
          name:
            [membership.user.firstName, membership.user.lastName].filter(Boolean).join(' ') || null,
          role: membership.role,
          userStatus: membership.user.status,
          lastLoginAt: membership.user.lastLoginAt?.toISOString() ?? null,
          lockedUntil:
            membership.user.lockedUntil && membership.user.lockedUntil > now
              ? membership.user.lockedUntil.toISOString()
              : null,
          failedLoginAttempts: membership.user.failedLoginAttempts,
          activeSessions: sessionsFor.get(membership.userId) ?? 0,
        })),
        modules: modules.map((entry) => ({ key: entry.moduleKey, enabled: entry.enabled })),
        invitations: invitations.map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          status: invitation.status,
          expiresAt: invitation.expiresAt.toISOString(),
          createdAt: invitation.createdAt.toISOString(),
        })),
        notes: notes.map((note) => ({
          id: note.id,
          body: note.body,
          authorEmail: note.authorEmail,
          createdAt: note.createdAt.toISOString(),
        })),
        activity: activity.map(toAuditEvent),
        plans: plans.map((plan) => ({
          key: plan.key,
          name: plan.name,
          maxLocations: plan.maxLocations,
        })),
        billing,
      };
    });
  }

  async auditTrail(staff: StaffIdentity): Promise<StaffAuditEvent[]> {
    const events = await this.prisma.withStaff(staff.userId, (tx) =>
      tx.staffAuditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
    );

    return events.map(toAuditEvent);
  }

  // -------------------------------------------------------------------------
  // Changing

  /**
   * Give a trial more time, or restart one that lapsed.
   *
   * Only for businesses on a trial. A paying or past-due business is a billing
   * matter, not a trial, and extending "its trial" would be meaningless.
   */
  async extendTrial(
    staff: StaffIdentity,
    organizationId: string,
    until: Date,
    reason: string,
  ): Promise<void> {
    const now = Date.now();

    if (until.getTime() <= now) {
      throw new BadRequestException('The new trial end must be in the future');
    }
    if (until.getTime() - now > MAX_TRIAL_EXTENSION) {
      throw new BadRequestException('A trial can be extended by at most a year at a time');
    }

    await this.prisma.withStaff(staff.userId, async (tx) => {
      const subscription = await this.subscriptionOf(tx, organizationId);

      // A business that has paid keeps its old trial date, so "suspended with a
      // trial date" alone would let a lapsed payer be handed a free trial.
      if (await this.billing.hasPaid(tx, organizationId)) {
        throw new BadRequestException(
          'This business has paid, so it is not on a trial. Record a payment or give credit instead.',
        );
      }

      const lapsedTrial = subscription.status === 'SUSPENDED' && subscription.trialEndsAt !== null;
      if (subscription.status !== 'TRIALING' && !lapsedTrial) {
        throw new BadRequestException('This business is not on a trial');
      }

      await tx.subscription.update({
        where: { organizationId },
        data: { status: 'TRIALING', trialEndsAt: until, periodEndsAt: until, graceEndsAt: null },
      });

      await recordStaffEvent(tx, staff, organizationId, 'trial.extended', reason, {
        from: subscription.trialEndsAt?.toISOString() ?? null,
        to: until.toISOString(),
        restarted: lapsedTrial,
      });
    });
  }

  /**
   * Move a business to another plan.
   *
   * Only the plan: a customer changing plan themselves is treated as starting
   * to pay, but staff moving a trial to a bigger plan must not end the trial
   * or restart the billing period. Add-ons the new plan already includes are
   * removed, so nothing is charged twice.
   */
  async changePlan(
    staff: StaffIdentity,
    organizationId: string,
    planKey: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.withStaff(staff.userId, async (tx) => {
      const subscription = await this.subscriptionOf(tx, organizationId);

      const plan = await tx.plan.findUnique({
        where: { key: planKey },
        include: { modules: true },
      });
      if (!plan) throw new BadRequestException('Unknown plan');
      if (plan.key === subscription.planKey) {
        throw new BadRequestException('The business is already on that plan');
      }

      const activeLocations = await tx.location.count({
        where: { organizationId, status: 'ACTIVE' },
      });
      if (plan.maxLocations !== null && activeLocations > plan.maxLocations) {
        throw new BadRequestException(
          `${plan.name} allows ${plan.maxLocations} location${plan.maxLocations === 1 ? '' : 's'}, ` +
            `and this business has ${activeLocations} active.`,
        );
      }

      await tx.subscription.update({ where: { organizationId }, data: { planKey: plan.key } });

      const removed = await tx.subscriptionAddOn.deleteMany({
        where: {
          subscriptionId: subscription.id,
          moduleKey: { in: plan.modules.map((entry) => entry.moduleKey) },
        },
      });

      await recordStaffEvent(tx, staff, organizationId, 'plan.changed', reason, {
        from: subscription.planKey,
        to: plan.key,
        addOnsRemoved: removed.count,
      });
    });
  }

  /**
   * Suspend or reactivate a business.
   *
   * Suspended means nobody in it can use the product at all — not the
   * read-only state a lapsed subscription gets. For abuse, or at the
   * business's own request; never for non-payment.
   */
  async setBusinessStatus(
    staff: StaffIdentity,
    organizationId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    reason: string,
  ): Promise<void> {
    await this.prisma.withStaff(staff.userId, async (tx) => {
      const organization = await tx.organization.findUnique({ where: { id: organizationId } });
      if (!organization) throw new NotFoundException();
      if (organization.status === status) {
        throw new BadRequestException(
          status === 'SUSPENDED'
            ? 'The business is already suspended'
            : 'The business is already active',
        );
      }

      await tx.organization.update({ where: { id: organizationId }, data: { status } });

      await recordStaffEvent(
        tx,
        staff,
        organizationId,
        status === 'SUSPENDED' ? 'business.suspended' : 'business.reactivated',
        reason,
        {},
      );
    });
  }

  /** Clear a sign-in lockout after too many wrong passwords. */
  async unlockMember(
    staff: StaffIdentity,
    organizationId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.withStaff(staff.userId, async (tx) => {
      const member = await this.memberOf(tx, organizationId, userId);

      await tx.user.update({
        where: { id: userId },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });

      await recordStaffEvent(tx, staff, organizationId, 'member.unlocked', reason, {
        userId,
        email: member.user.email,
        wasLockedUntil: member.user.lockedUntil?.toISOString() ?? null,
      });
    });
  }

  /** End every session the person has — a lost phone, a shared computer. */
  async signOutMember(
    staff: StaffIdentity,
    organizationId: string,
    userId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.withStaff(staff.userId, async (tx) => {
      const member = await this.memberOf(tx, organizationId, userId);

      const revoked = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await recordStaffEvent(tx, staff, organizationId, 'member.signed-out', reason, {
        userId,
        email: member.user.email,
        sessionsEnded: revoked.count,
      });
    });
  }

  /**
   * A fresh link for a pending invitation.
   *
   * Only the hash of a link is ever stored, so an old link cannot be shown
   * again; it can only be replaced. The previous link stops working.
   */
  async reissueInvitation(
    staff: StaffIdentity,
    organizationId: string,
    invitationId: string,
    reason: string,
  ): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await this.prisma.withStaff(staff.userId, async (tx) => {
      const invitation = await tx.invitation.findFirst({
        where: { id: invitationId, organizationId },
      });
      if (!invitation) throw new NotFoundException();
      if (invitation.status !== 'PENDING') {
        throw new BadRequestException('Only a pending invitation can be given a new link');
      }

      await tx.invitation.update({
        where: { id: invitationId },
        data: {
          tokenHash: hashInvitationToken(token),
          expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY),
        },
      });

      await recordStaffEvent(tx, staff, organizationId, 'invitation.reissued', reason, {
        invitationId,
        email: invitation.email,
      });
    });

    return `${this.env.APP_URL}/invitations/accept?token=${token}`;
  }

  async addNote(staff: StaffIdentity, organizationId: string, body: string): Promise<void> {
    await this.prisma.withStaff(staff.userId, async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { id: true },
      });
      if (!organization) throw new NotFoundException();

      await tx.staffNote.create({
        data: { organizationId, authorUserId: staff.userId, authorEmail: staff.email, body },
      });

      await recordStaffEvent(tx, staff, organizationId, 'note.added', null, {
        length: body.length,
      });
    });
  }

  // -------------------------------------------------------------------------

  private async subscriptionOf(tx: TransactionClient, organizationId: string) {
    const subscription = await tx.subscription.findUnique({ where: { organizationId } });
    if (!subscription) throw new NotFoundException();
    return subscription;
  }

  /** A user who belongs to this business; 404 otherwise, so ids cannot be probed across businesses. */
  private async memberOf(tx: TransactionClient, organizationId: string, userId: string) {
    const membership = await tx.organizationMembership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      include: { user: true },
    });
    if (!membership) throw new NotFoundException();
    return membership;
  }
}
