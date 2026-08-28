import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@platform/shared';
import { IS_PUBLIC_KEY } from '../auth/auth.decorators';
import {
  REQUIRED_ANYWHERE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  type PermissionRequest,
} from './rbac.decorators';

/**
 * Enforces `@RequirePermission` on endpoints that declare it.
 *
 * Registered globally, and runs after TenantGuard so permissions are already
 * resolved and attached to the request.
 *
 * Note this guard is NOT fail-closed in the way AuthGuard and TenantGuard are:
 * an endpoint with no `@RequirePermission` passes through. That is deliberate.
 * Requiring every route to name a permission would mean inventing one for
 * `/auth/me`, and a mandatory-but-meaningless annotation quickly becomes
 * copy-pasted noise that nobody reads — which is worse than no annotation.
 *
 * The fail-closed layers that matter still apply underneath: authentication,
 * tenant context, and row-level security. An endpoint that forgets a
 * permission check is still restricted to the caller's own organization.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<PermissionKey[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const requiredAnywhere = this.reflector.getAllAndOverride<PermissionKey[]>(
      REQUIRED_ANYWHERE_KEY,
      [context.getHandler(), context.getClass()],
    );

    const hasOrgWide = required && required.length > 0;
    const hasAnywhere = requiredAnywhere && requiredAnywhere.length > 0;

    if (!hasOrgWide && !hasAnywhere) return true;

    const request = context.switchToHttp().getRequest<PermissionRequest>();
    const permissions = request.permissions;

    if (!permissions) {
      // TenantGuard attaches these. Reaching here means guard order changed.
      throw new ForbiddenException('Permissions could not be resolved');
    }

    // ALL declared permissions are required, not any. Requiring only one would
    // make a multi-permission decorator quietly weaker than it reads.
    const missing = [
      ...(hasOrgWide ? required.filter((permission) => !permissions.has(permission)) : []),
      ...(hasAnywhere
        ? requiredAnywhere.filter((permission) => !permissions.hasAnywhere(permission))
        : []),
    ];

    if (missing.length > 0) {
      // 403 rather than 404: the caller demonstrably belongs to this
      // organization, so refusing on permission grounds reveals nothing about
      // what exists. Cross-tenant probes never reach this guard — RLS and the
      // service layer return 404 first.
      throw new ForbiddenException(
        `You do not have permission to do this (requires ${missing.join(', ')})`,
      );
    }

    return true;
  }
}
