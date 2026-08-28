import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ModuleKey } from '@platform/shared';

export const REQUIRED_MODULE_KEY = 'modules:required';

/**
 * Declares which module an endpoint belongs to.
 *
 * Enforced by EntitlementGuard. This is what makes a disabled module genuinely
 * unreachable rather than merely hidden: the navigation not showing Inventory
 * is a usability choice, but calling its endpoint directly must fail too.
 *
 * Applied at the controller level, since a module owns whole controllers
 * rather than scattered handlers. `grep RequireModule` then enumerates every
 * gated surface in the codebase.
 */
export const RequireModule = (module: ModuleKey) => SetMetadata(REQUIRED_MODULE_KEY, module);

export interface ModuleRequest {
  enabledModules?: Set<string>;
}

/** Injects the module keys this organization may use. */
export const EnabledModules = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<ModuleRequest>();
  return request.enabledModules;
});
