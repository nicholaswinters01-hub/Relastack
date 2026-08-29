import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type TenantContext } from '@platform/db';
import { PERMISSIONS } from '@platform/shared';
import type {
  CreateLocationRequest,
  Location,
  LocationMember,
  UpdateLocationRequest,
} from '@platform/shared';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

/**
 * Cross-tenant and unassigned access are both reported as "not found".
 *
 * A 403 would confirm the record exists. Within an organization that is
 * usually harmless, but for a location it would let an unassigned employee
 * enumerate which locations the business has — so the same rule applies.
 */
const NOT_FOUND = 'Location not found';

type LocationRow = Prisma.LocationGetPayload<{
  include: { _count: { select: { memberships: true } } };
}>;

@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  static toPublic(row: LocationRow): Location {
    return {
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      slug: row.slug,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      country: row.country,
      phone: row.phone,
      email: row.email,
      timezone: row.timezone,
      status: row.status,
      memberCount: row._count.memberships,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Slug unique within the organization, not globally.
   *
   * Two businesses may each have a "Downtown"; one business may not. The
   * random suffix avoids a collision retry loop, and avoids sequential
   * numbering that would let anyone reading a slug infer how many similarly
   * named locations exist.
   */
  private buildSlug(name: string): string {
    const base = name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

    return `${base || 'location'}-${randomBytes(3).toString('hex')}`;
  }

  /**
   * Which locations the caller may see.
   *
   * Phase 3 rule, deliberately simple: an owner reaches every location in the
   * organization; anyone else reaches only those they are assigned to. Phase 4
   * generalises this into scoped permissions, and building that machinery
   * twice would be waste.
   *
   * Note this is scoping WITHIN a tenant. The tenant boundary itself is
   * already handled — RLS makes another organization's locations invisible
   * regardless of what this returns.
   */
  private visibilityFilter(permissions: PermissionSet): Prisma.LocationWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.LOCATION_READ);

    // null means the permission is held organization-wide, so no filter at
    // all — deliberately not "the ids of the locations that exist right now",
    // which would be a snapshot excluding anything created afterwards.
    if (allowed === null) return {};

    return { id: { in: [...allowed] } };
  }

  private assertPermission(
    permissions: PermissionSet,
    permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
    action: string,
  ): void {
    if (!permissions.has(permission)) {
      // A permission failure, not an existence question: the caller
      // demonstrably belongs to this organization, so 403 leaks nothing.
      throw new ForbiddenException(`You do not have permission to ${action}`);
    }
  }

  private assertPermissionAt(
    permissions: PermissionSet,
    permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
    locationId: string,
    action: string,
  ): void {
    // The distinction that justifies the whole scope model: a Location Manager
    // may do this at their own branches and nowhere else.
    if (!permissions.hasAt(permission, locationId)) {
      throw new ForbiddenException(`You do not have permission to ${action} at this location`);
    }
  }

  async create(
    context: TenantContext,
    permissions: PermissionSet,
    input: CreateLocationRequest,
  ): Promise<Location> {
    // Organization-wide, deliberately. Creating a location adds a billable
    // unit, so it is a company decision rather than something a Location
    // Manager does for their own branch.
    this.assertPermission(permissions, PERMISSIONS.LOCATION_WRITE, 'create locations');

    // Locations are the billing unit, so the plan caps them. Checked before
    // creating rather than after, so a refused request leaves nothing behind.
    const subscription = await this.billing.resolveFor(context);

    if (subscription?.maxLocations != null) {
      const active = await this.countActive(context);

      if (active >= subscription.maxLocations) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'LOCATION_LIMIT_REACHED',
          maxLocations: subscription.maxLocations,
          message: `Your plan includes ${subscription.maxLocations} location${subscription.maxLocations === 1 ? '' : 's'}. Upgrade to add more.`,
        });
      }
    }

    try {
      const location = await this.prisma.withTenant(context, (tx) =>
        tx.location.create({
          data: {
            organizationId: context.organizationId,
            name: input.name,
            slug: this.buildSlug(input.name),
            addressLine1: input.addressLine1 ?? null,
            addressLine2: input.addressLine2 ?? null,
            city: input.city ?? null,
            region: input.region ?? null,
            postalCode: input.postalCode ?? null,
            country: input.country ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            timezone: input.timezone,
          },
          include: { _count: { select: { memberships: true } } },
        }),
      );

      this.logger.log(`Location created: ${location.id} in organization ${context.organizationId}`);

      return LocationsService.toPublic(location);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A location with that name already exists');
      }
      throw error;
    }
  }

  async list(context: TenantContext, permissions: PermissionSet): Promise<Location[]> {
    const locations = await this.prisma.withTenant(context, (tx) =>
      tx.location.findMany({
        where: this.visibilityFilter(permissions),
        include: { _count: { select: { memberships: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return locations.map(LocationsService.toPublic);
  }

  async getById(context: TenantContext, permissions: PermissionSet, id: string): Promise<Location> {
    const location = await this.prisma.withTenant(context, (tx) =>
      tx.location.findFirst({
        // AND, not an object spread. The filter carries its own `id` key, so
        // `{ id, ...filter }` silently DISCARDS the requested id and returns
        // whatever the filter matches first — asking for one location and
        // getting a different one, with a 200.
        where: { AND: [{ id }, this.visibilityFilter(permissions)] },
        include: { _count: { select: { memberships: true } } },
      }),
    );

    // The organizationId comparison is deliberately redundant with RLS.
    // Defence in depth only works when the layers are independent — a
    // misconfigured database must not silently turn this into a cross-tenant
    // read. See the same reasoning in OrganizationsService.getById.
    if (!location || location.organizationId !== context.organizationId) {
      throw new NotFoundException(NOT_FOUND);
    }

    return LocationsService.toPublic(location);
  }

  async update(
    context: TenantContext,
    permissions: PermissionSet,
    id: string,
    input: UpdateLocationRequest,
  ): Promise<Location> {
    // Confirms existence and visibility before anything else, so a
    // cross-tenant or unassigned id produces 404 rather than 403 — a 403 here
    // would confirm the location exists.
    await this.getById(context, permissions, id);

    // Scoped: a Location Manager may edit the branches they run.
    this.assertPermissionAt(permissions, PERMISSIONS.LOCATION_WRITE, id, 'edit locations');

    const location = await this.prisma.withTenant(context, (tx) =>
      tx.location.update({
        where: { id },
        data: {
          name: input.name,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          region: input.region ?? null,
          postalCode: input.postalCode ?? null,
          country: input.country ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          timezone: input.timezone,
          ...(input.status ? { status: input.status } : {}),
        },
        include: { _count: { select: { memberships: true } } },
      }),
    );

    this.logger.log(`Location ${id} updated by ${context.userId}`);

    return LocationsService.toPublic(location);
  }

  async listMembers(
    context: TenantContext,
    permissions: PermissionSet,
    locationId: string,
  ): Promise<LocationMember[]> {
    await this.getById(context, permissions, locationId);

    const assignments = await this.prisma.withTenant(context, (tx) =>
      tx.locationMembership.findMany({
        where: { locationId },
        include: { membership: { include: { user: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return assignments.map((assignment) => ({
      membershipId: assignment.membershipId,
      userId: assignment.membership.userId,
      email: assignment.membership.user.email,
      firstName: assignment.membership.user.firstName,
      lastName: assignment.membership.user.lastName,
      assignedAt: assignment.createdAt.toISOString(),
    }));
  }

  /**
   * Assign an organization member to a location.
   *
   * Takes a membership id rather than a user id, which structurally prevents
   * naming someone from another company: they hold no membership in this
   * organization to reference, and RLS makes any membership row outside the
   * current tenant invisible to the lookup below.
   */
  async assignMember(
    context: TenantContext,
    permissions: PermissionSet,
    locationId: string,
    membershipId: string,
  ): Promise<LocationMember[]> {
    await this.getById(context, permissions, locationId);
    this.assertPermissionAt(permissions, PERMISSIONS.LOCATION_ASSIGN, locationId, 'assign people');

    await this.prisma.withTenant(context, async (tx) => {
      const membership = await tx.organizationMembership.findFirst({
        where: { id: membershipId, organizationId: context.organizationId },
      });

      if (!membership) throw new NotFoundException('Member not found');

      // Upsert rather than create-and-catch.
      //
      // PostgreSQL aborts the entire transaction the moment any statement
      // errors — every later command fails with "current transaction is
      // aborted" until rollback. So catching a unique-violation and carrying
      // on inside a transaction does not work, however reasonable it looks.
      // Assigning someone who is already assigned is the caller's intent
      // either way, so never provoke the error in the first place.
      await tx.locationMembership.upsert({
        where: { membershipId_locationId: { membershipId, locationId } },
        create: { membershipId, locationId, organizationId: context.organizationId },
        update: {},
      });

      // Extend the member's location-scoped roles to cover this location.
      //
      // Staffing and permission are separate tables — someone may manage a
      // branch they do not work at — but they must not drift apart in the
      // ordinary case. Without this, an owner who assigns an employee to a
      // location would find that employee still unable to see it, and would
      // have no obvious way to fix that. One user-facing action, both records.
      const scopedRoles = await tx.membershipRole.findMany({
        where: { membershipId, scope: 'LOCATION' },
      });

      for (const assignment of scopedRoles) {
        await tx.membershipRoleLocation.upsert({
          where: {
            membershipRoleId_locationId: { membershipRoleId: assignment.id, locationId },
          },
          create: {
            membershipRoleId: assignment.id,
            locationId,
            organizationId: context.organizationId,
          },
          update: {},
        });
      }
    });

    this.logger.log(`Membership ${membershipId} assigned to location ${locationId}`);

    return this.listMembers(context, permissions, locationId);
  }

  async removeMember(
    context: TenantContext,
    permissions: PermissionSet,
    locationId: string,
    membershipId: string,
  ): Promise<LocationMember[]> {
    await this.getById(context, permissions, locationId);
    this.assertPermissionAt(permissions, PERMISSIONS.LOCATION_ASSIGN, locationId, 'remove people');

    await this.prisma.withTenant(context, async (tx) => {
      await tx.locationMembership.deleteMany({ where: { locationId, membershipId } });

      // Withdraw the matching permission scope, or removing someone from a
      // location would leave them able to see it indefinitely.
      const scopedRoles = await tx.membershipRole.findMany({
        where: { membershipId, scope: 'LOCATION' },
        select: { id: true },
      });

      await tx.membershipRoleLocation.deleteMany({
        where: {
          locationId,
          membershipRoleId: { in: scopedRoles.map((assignment) => assignment.id) },
        },
      });
    });

    this.logger.log(`Membership ${membershipId} removed from location ${locationId}`);

    return this.listMembers(context, permissions, locationId);
  }

  /**
   * How many active locations the organization has.
   *
   * The number a subscription is priced on. Phase 6 consumes this; it lives
   * here because the locations module owns what counts as a billable location.
   */
  async countActive(context: TenantContext): Promise<number> {
    return this.prisma.withTenant(context, (tx) =>
      tx.location.count({ where: { organizationId: context.organizationId, status: 'ACTIVE' } }),
    );
  }
}
