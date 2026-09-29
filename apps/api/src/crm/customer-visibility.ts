import type { Prisma } from '@platform/db';
import type { PermissionKey } from '@platform/shared';
import type { PermissionSet } from '../rbac/permission-set';

/**
 * Which customers a permission reaches: organization-wide, or through a
 * customer's primary or shared location. The reasoning is on
 * CustomersService.visibilityFilter; this is here so an export can ask the
 * same question of its own permission.
 */
export function customerVisibility(
  permissions: PermissionSet,
  permission: PermissionKey,
): Prisma.CustomerWhereInput {
  const allowed = permissions.locationsFor(permission);

  // null means the permission is held organization-wide, so no filter at
  // all — deliberately not "the ids of the locations that exist right now",
  // which would be a snapshot excluding anything created afterwards.
  if (allowed === null) return {};

  const ids = [...allowed];

  return {
    OR: [{ locationId: { in: ids } }, { sharedLocations: { some: { locationId: { in: ids } } } }],
  };
}
