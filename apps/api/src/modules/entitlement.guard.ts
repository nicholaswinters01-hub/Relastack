import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MODULE_BY_KEY, type ModuleKey } from '@platform/shared';
import { IS_PUBLIC_KEY } from '../auth/auth.decorators';
import { REQUIRED_MODULE_KEY, type ModuleRequest } from './module.decorators';

/**
 * Refuses endpoints belonging to a module the organization does not have.
 *
 * Registered globally, and runs after TenantGuard so the entitlement set is
 * already resolved and attached to the request.
 *
 * This guard is what separates "the customer cannot see it" from "the customer
 * cannot reach it". Hiding a navigation item is a usability choice; someone
 * reading the network tab and calling the endpoint directly must be refused
 * here, which is the requirement that makes modules a commercial boundary
 * rather than a cosmetic one.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<ModuleKey>(REQUIRED_MODULE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Endpoints without @RequireModule belong to core, which is always on.
    if (!required) return true;

    const request = context.switchToHttp().getRequest<ModuleRequest>();
    const enabled = request.enabledModules;

    if (!enabled) {
      // TenantGuard attaches this. Reaching here means guard order changed.
      throw new ForbiddenException('Module entitlements could not be resolved');
    }

    if (!enabled.has(required)) {
      const definition = MODULE_BY_KEY.get(required);

      // 403 with a machine-readable code rather than 404.
      //
      // Unlike another tenant's data, a module's existence is not secret — it
      // is on the pricing page. Hiding it behind 404 would leak nothing but
      // would also leave the interface unable to offer the upgrade, which is
      // the whole commercial point of a modular product.
      throw new ForbiddenException({
        statusCode: 403,
        code: 'MODULE_NOT_ENABLED',
        moduleKey: required,
        message: `${definition?.name ?? required} is not enabled for your organization.`,
      });
    }

    return true;
  }
}
