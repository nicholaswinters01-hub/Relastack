import type { PermissionKey, ResolvedPermissions } from '@platform/shared';

/**
 * Client-side permission checks.
 *
 * These decide what the interface OFFERS, never what it allows. Hiding a
 * button the user cannot use is a usability courtesy; the API enforces the
 * same rules regardless of what the browser renders, and the e2e suite asserts
 * that calling a forbidden endpoint directly still fails.
 *
 * Mirrors the server's PermissionSet so the two read alike, which makes it
 * harder to write a check here that means something subtly different there.
 */

/** Held across the whole organization. */
export function can(permissions: ResolvedPermissions, permission: PermissionKey): boolean {
  return permissions.organizationWide.includes(permission);
}

/** Held at a specific location, whether organization-wide or scoped to it. */
export function canAt(
  permissions: ResolvedPermissions,
  permission: PermissionKey,
  locationId: string,
): boolean {
  if (can(permissions, permission)) return true;

  return permissions.byLocation[permission]?.includes(locationId) ?? false;
}

/** Held organization-wide or at least somewhere. */
export function canAnywhere(permissions: ResolvedPermissions, permission: PermissionKey): boolean {
  if (can(permissions, permission)) return true;

  return (permissions.byLocation[permission]?.length ?? 0) > 0;
}

/** Human-readable role names, for display only. */
export function roleLabel(roleKey: string): string {
  const labels: Record<string, string> = {
    org_admin: 'Organization Administrator',
    location_manager: 'Location Manager',
    employee: 'Employee',
  };

  return labels[roleKey] ?? roleKey;
}
