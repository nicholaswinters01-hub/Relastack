import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '@platform/shared';
import type { PermissionSet } from './permission-set';

export const REQUIRED_PERMISSIONS_KEY = 'rbac:requiredPermissions';
export const REQUIRED_ANYWHERE_KEY = 'rbac:requiredAnywhere';

/**
 * Declares the organization-wide permissions an endpoint requires.
 *
 * Checked by PermissionGuard before the handler runs, so the rule sits next to
 * the route it protects and is greppable — `grep RequirePermission` enumerates
 * every protected endpoint and what it needs.
 *
 * Deliberately checks ORGANIZATION-wide grants only. Anything scoped to a
 * particular location cannot be decided from the route alone: which location
 * is in the request body or path, so the service checks it with `hasAt`. A
 * decorator that silently accepted a location-scoped grant here would let a
 * Location Manager perform company-wide actions.
 */
export const RequirePermission = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Declares permissions the caller must hold SOMEWHERE — organization-wide, or
 * at any single location.
 *
 * For listing and reading endpoints, where a Location Manager or Employee
 * legitimately has access to part of the data. Requiring the organization-wide
 * grant on those would lock scoped users out of their own branches, which is
 * the opposite of what scoping is for.
 *
 * The endpoint is then responsible for narrowing results to what the caller
 * may actually see — the guard only establishes that they may see something.
 */
export const RequirePermissionAnywhere = (...permissions: PermissionKey[]) =>
  SetMetadata(REQUIRED_ANYWHERE_KEY, permissions);

export interface PermissionRequest {
  permissions?: PermissionSet;
  membershipId?: string;
}

/**
 * Injects the caller's resolved permissions.
 *
 * Services take this and make scope-aware decisions — `hasAt(permission,
 * locationId)` — that a route-level decorator cannot express.
 */
export const CurrentPermissions = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<PermissionRequest>();
  return request.permissions;
});

/** Injects the caller's organization membership id. */
export const CurrentMembershipId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<PermissionRequest>();
  return request.membershipId;
});
