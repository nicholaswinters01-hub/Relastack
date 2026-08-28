import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionSet } from './permission-set';

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve everything a member may do, in one query.
   *
   * Called once per request by TenantGuard and attached to the request, rather
   * than being asked repeatedly. A permission check that hits the database is
   * a permission check developers avoid adding, and the checks people skip are
   * the ones that turn into vulnerabilities.
   *
   * A member may hold several assignments at once — organization-wide Employee
   * plus Location Manager at two branches is an ordinary arrangement — so the
   * grants are unioned rather than the "highest" role winning.
   */
  async resolveFor(context: TenantContext, membershipId: string): Promise<PermissionSet> {
    const assignments = await this.prisma.withTenant(context, (tx) =>
      tx.membershipRole.findMany({
        where: { membershipId },
        include: {
          role: { include: { permissions: true } },
          locations: true,
        },
      }),
    );

    const organizationWide = new Set<string>();
    const byLocation = new Map<string, Set<string>>();
    const roleKeys: string[] = [];

    for (const assignment of assignments) {
      roleKeys.push(assignment.role.key);

      const permissions = assignment.role.permissions.map((entry) => entry.permissionKey);

      if (assignment.scope === 'ORGANIZATION') {
        for (const permission of permissions) organizationWide.add(permission);
        continue;
      }

      // A LOCATION-scoped assignment naming no locations grants nothing. That
      // is the correct reading — the alternative, treating "no locations" as
      // "all locations", would turn a half-finished assignment into a silent
      // organization-wide grant.
      for (const permission of permissions) {
        let locations = byLocation.get(permission);
        if (!locations) {
          locations = new Set<string>();
          byLocation.set(permission, locations);
        }
        for (const link of assignment.locations) locations.add(link.locationId);
      }
    }

    if (assignments.length === 0) {
      // Reachable if a membership exists with no role assigned. Denies
      // everything, which is right, but it means someone is locked out of a
      // company they belong to — worth seeing in the logs.
      this.logger.warn(`Membership ${membershipId} holds no role assignments`);
    }

    return new PermissionSet(organizationWide, byLocation, roleKeys);
  }

  /** System and organization roles available for assignment. */
  async listAssignableRoles(context: TenantContext) {
    return this.prisma.withTenant(context, (tx) =>
      tx.role.findMany({
        // RLS admits shared system roles (organization_id IS NULL) alongside
        // this tenant's own, so no filter is needed here.
        include: { permissions: true },
        orderBy: [{ isSystem: 'desc' }, { key: 'asc' }],
      }),
    );
  }

  /** Look up a role by key, within what the caller is allowed to see. */
  async findRoleByKey(context: TenantContext, key: string) {
    return this.prisma.withTenant(context, (tx) => tx.role.findFirst({ where: { key } }));
  }
}
