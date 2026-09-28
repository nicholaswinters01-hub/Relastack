import { randomBytes } from 'node:crypto';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  Organization as OrganizationRow,
  Prisma,
  TenantContext,
  TransactionClient,
} from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  SYSTEM_ROLE_IDS,
  type Organization,
  type OrganizationMember,
  type SetupProgress,
  type UpdateOrganizationRequest,
} from '@platform/shared';
import { BillingService } from '../billing/billing.service';
import { checkPackFields } from '../packs/pack-fields';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

/**
 * Cross-tenant access is reported as "not found", never "forbidden".
 *
 * A 403 confirms the record exists, which is itself a leak across the tenant
 * boundary: an attacker enumerating identifiers learns what other
 * organizations own. Another tenant's data must be indistinguishable from data
 * that does not exist.
 */
const NOT_FOUND = 'Organization not found';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  static toPublic(row: OrganizationRow): Organization {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Build a URL-safe, globally unique slug.
   *
   * Slugs are unique across the whole platform, so two businesses with the
   * same name cannot both take it. A random suffix avoids both a collision
   * retry loop and the information leak of sequential numbering, which would
   * let anyone registering "acme-3" infer that two other Acmes exist.
   */
  private buildSlug(name: string): string {
    const base = name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

    return `${base || 'org'}-${randomBytes(4).toString('hex')}`;
  }

  /**
   * Create an organization and its owner membership.
   *
   * Runs inside the caller's transaction so that account creation and
   * organization creation commit or fail together — a user who exists with no
   * organization would be stranded, unable to reach any business endpoint.
   *
   * The organization's UUID is generated here rather than by the database
   * because tenant context must be established BEFORE the insert: the RLS
   * WITH CHECK clause compares the new row's id against
   * `app.current_organization_id`, which cannot reference a value the database
   * has not produced yet.
   */
  async createForOwner(
    tx: TransactionClient,
    organizationId: string,
    userId: string,
    name: string,
  ): Promise<OrganizationRow> {
    const organization = await tx.organization.create({
      data: { id: organizationId, name, slug: this.buildSlug(name) },
    });

    const membership = await tx.organizationMembership.create({
      // The legacy `role` column is still written so that a rollback to the
      // previous release would not strand this member without a role. It is
      // dropped once nothing reads it.
      data: { userId, organizationId: organization.id, role: 'OWNER' },
    });

    // Core carries the account itself — signing in, locations, people. An
    // organization committed without it would be locked out of its own data.
    await tx.organizationModule.create({
      data: {
        organizationId: organization.id,
        moduleKey: 'core',
        enabled: true,
        enabledAt: new Date(),
      },
    });

    // Entitlement is derived from the subscription, so an organization
    // committed without one would resolve to no modules and be locked out of
    // its own account.
    await this.billing.createTrialForNewOrganization(tx, organization.id);

    // The assignment that actually grants anything from Phase 4 onward.
    // Organization-scoped, so it reaches every location including ones created
    // later.
    await tx.membershipRole.create({
      data: {
        membershipId: membership.id,
        roleId: SYSTEM_ROLE_IDS.org_admin,
        scope: 'ORGANIZATION',
        organizationId: organization.id,
      },
    });

    this.logger.log(`Organization created: ${organization.id} (owner ${userId})`);

    return organization;
  }

  /** The caller's own organization. */
  async getCurrent(context: TenantContext): Promise<Organization> {
    const organization = await this.prisma.withTenant(context, (tx) =>
      tx.organization.findUnique({ where: { id: context.organizationId } }),
    );

    // Unreachable while TenantGuard is in place, but the service must not
    // depend on a guard having run — services are called from jobs and tests
    // too.
    if (!organization) throw new NotFoundException(NOT_FOUND);

    return OrganizationsService.toPublic(organization);
  }

  /**
   * Fetch an organization by id.
   *
   * Guarded twice, independently: the query runs under tenant context so RLS
   * returns nothing for an id outside the caller's organization, and the
   * result is then checked explicitly. Requesting another tenant's id is
   * indistinguishable from requesting one that does not exist.
   */
  async getById(context: TenantContext, id: string): Promise<Organization> {
    const organization = await this.prisma.withTenant(context, (tx) =>
      tx.organization.findUnique({ where: { id } }),
    );

    // The second condition is deliberately redundant with RLS.
    //
    // Defence in depth only works when the layers are independent. Relying on
    // the policy alone would mean a misconfigured database — RLS disabled
    // during an incident, a role accidentally granted BYPASSRLS, a restore
    // from a dump that dropped policies — silently turns this endpoint into a
    // cross-tenant read. Checking here costs one comparison and removes that
    // shared fate.
    if (!organization || organization.id !== context.organizationId) {
      throw new NotFoundException(NOT_FOUND);
    }

    return OrganizationsService.toPublic(organization);
  }

  /**
   * Rename the organization. Owners only.
   *
   * The slug deliberately does not change: it may already appear in links and
   * external integrations, and silently breaking those to match a display name
   * is a poor trade. Phase 6 can add an explicit slug change with redirects.
   */
  async update(
    context: TenantContext,
    permissions: PermissionSet,
    input: UpdateOrganizationRequest,
  ): Promise<Organization> {
    if (!permissions.has(PERMISSIONS.ORGANIZATION_WRITE)) {
      // A permission failure, not an existence question — the caller already
      // demonstrably belongs here, so 403 leaks nothing.
      throw new ForbiddenException('You do not have permission to change organization settings');
    }

    const organization = await this.prisma.withTenant(context, (tx) =>
      tx.organization.update({
        where: { id: context.organizationId },
        data: { name: input.name },
      }),
    );

    this.logger.log(`Organization ${organization.id} renamed by ${context.userId}`);

    return OrganizationsService.toPublic(organization);
  }

  /**
   * Members of the caller's organization, with their scoped role assignments.
   *
   * Assignments are included rather than a single flat role because a member
   * may hold several — organization-wide Employee plus Location Manager at two
   * branches — and showing only one would misrepresent their access.
   */
  async listMembers(context: TenantContext): Promise<OrganizationMember[]> {
    const memberships = await this.prisma.withTenant(context, (tx) =>
      tx.organizationMembership.findMany({
        where: { organizationId: context.organizationId },
        include: {
          user: true,
          roleAssignments: { include: { role: true, locations: true } },
          groupMemberships: { select: { groupId: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return memberships.map((membership) => ({
      membershipId: membership.id,
      userId: membership.userId,
      email: membership.user.email,
      firstName: membership.user.firstName,
      lastName: membership.user.lastName,
      roles: membership.roleAssignments.map((assignment) => ({
        id: assignment.id,
        roleKey: assignment.role.key,
        roleName: assignment.role.name,
        scope: assignment.scope,
        locationIds: assignment.locations.map((link) => link.locationId),
      })),
      groupIds: membership.groupMemberships.map((link) => link.groupId),
      joinedAt: membership.createdAt.toISOString(),
      packFields:
        membership.packFields !== null &&
        typeof membership.packFields === 'object' &&
        !Array.isArray(membership.packFields)
          ? (membership.packFields as Record<string, unknown>)
          : {},
    }));
  }

  /**
   * Set what an enabled pack records about a person, such as an applicator's
   * license. Merged over what they already have inside the transaction, so
   * sending the expiry never wipes the number.
   */
  async setMemberPackFields(
    context: TenantContext,
    enabledModules: ReadonlySet<string>,
    membershipId: string,
    packFields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.prisma.withTenant(context, async (tx) => {
      const membership = await tx.organizationMembership.findUnique({
        where: { id: membershipId },
        select: { packFields: true },
      });
      if (!membership) throw new NotFoundException('That person is not in this business');

      const merged = checkPackFields(
        'member',
        packFields,
        membership.packFields,
        enabledModules,
        'merge',
      );
      await tx.organizationMembership.update({
        where: { id: membershipId },
        data: { packFields: merged as Prisma.InputJsonValue },
      });
      return merged;
    });
  }

  /**
   * What the business has set up so far, for the "Get started" card.
   *
   * Counts rather than stored ticks, so a step is done when the thing exists
   * and undone if it is removed. Owners and admins only (the route says so);
   * they see the whole business, so these counts disclose nothing new.
   */
  async setupProgress(context: TenantContext): Promise<SetupProgress> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: context.userId },
      select: { firstName: true },
    });

    const counts = await this.prisma.withTenant(context, async (tx) => ({
      modules: await tx.organizationModule.count({
        where: { enabled: true, moduleKey: { not: MODULES.CORE } },
      }),
      locations: await tx.location.count(),
      members: await tx.organizationMembership.count(),
      invitations: await tx.invitation.count({ where: { status: 'PENDING' } }),
      customers: await tx.customer.count(),
      jobs: await tx.job.count(),
    }));

    return {
      hasName: Boolean(user?.firstName),
      hasModules: counts.modules > 0,
      hasLocation: counts.locations > 0,
      hasTeammate: counts.members > 1 || counts.invitations > 0,
      hasCustomer: counts.customers > 0,
      hasJob: counts.jobs > 0,
    };
  }
}
