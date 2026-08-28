import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import type { OrganizationRole } from '@platform/db';

export const ALLOW_NO_ORGANIZATION_KEY = 'tenancy:allowNoOrganization';

/**
 * Marks an endpoint as reachable by an authenticated user who belongs to no
 * organization.
 *
 * Almost nothing should carry this. It exists for endpoints that operate on
 * identity rather than business data — `/auth/me`, `/auth/logout` — which must
 * keep working for a user whose membership has been removed, so they can at
 * least see who they are and sign out.
 */
export const AllowNoOrganization = () => SetMetadata(ALLOW_NO_ORGANIZATION_KEY, true);

export interface TenantRequest {
  tenant?: TenantContext;
  membershipRole?: OrganizationRole;
}

/**
 * Injects the tenant context established by TenantGuard.
 *
 * Services take this as their first argument, which is what makes "forgot to
 * scope the query" a compile error rather than a data leak.
 */
export const CurrentTenant = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<TenantRequest>();
  return request.tenant;
});

/** Injects the caller's role within the current organization. */
export const CurrentMembershipRole = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<TenantRequest>();
    return request.membershipRole;
  },
);
