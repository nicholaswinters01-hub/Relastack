import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../auth/auth.decorators';
import type { FastifyRequest } from '../auth/fastify.types';
import { EntitlementService } from '../modules/entitlement.service';
import type { ModuleRequest } from '../modules/module.decorators';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionRequest } from '../rbac/rbac.decorators';
import { ALLOW_NO_ORGANIZATION_KEY, type TenantRequest } from './tenant.decorators';
import { TenantService } from './tenant.service';

/**
 * Establishes which organization a request acts on, and what the caller may do
 * within it.
 *
 * Runs after AuthGuard, so a caller is already known. Registered globally, so
 * every endpoint has tenant context unless it explicitly opts out — the same
 * fail-closed arrangement as authentication. An endpoint that forgets to
 * declare its intent gets a request with no tenant, and since RLS policies
 * fail closed, its queries return nothing rather than everything.
 *
 * Permissions are resolved here, once, and attached to the request. Resolving
 * them lazily per check would put a database round-trip behind every
 * authorization question, and checks that are expensive are checks developers
 * quietly stop adding.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantService,
    private readonly permissions: PermissionService,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & TenantRequest & PermissionRequest & ModuleRequest>();
    const session = request.session;

    if (!session) {
      // AuthGuard should have rejected this already; reaching here means the
      // guard order in AppModule was changed.
      throw new UnauthorizedException('Authentication required');
    }

    const allowNoOrganization = this.reflector.getAllAndOverride<boolean>(
      ALLOW_NO_ORGANIZATION_KEY,
      [context.getHandler(), context.getClass()],
    );

    const membership = await this.tenants.resolveMembership(session.userId);

    if (!membership) {
      if (allowNoOrganization) return true;

      throw new ForbiddenException('You do not belong to an organization');
    }

    const tenant = {
      organizationId: membership.organizationId,
      userId: session.userId,
    };

    if (!(await this.tenants.isOrganizationActive(tenant))) {
      if (allowNoOrganization) return true;

      // Same message whether suspended or missing — an outsider probing must
      // not be able to tell the difference.
      throw new ForbiddenException('Your organization is not active');
    }

    request.tenant = tenant;
    request.membershipId = membership.id;

    // Both resolved once, here, and attached to the request. Independent
    // queries, so they run together.
    const [permissions, enabledModules] = await Promise.all([
      this.permissions.resolveFor(tenant, membership.id),
      this.entitlements.resolveFor(tenant),
    ]);

    request.permissions = permissions;
    request.enabledModules = enabledModules;

    return true;
  }
}
