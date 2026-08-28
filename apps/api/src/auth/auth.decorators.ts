import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedSession } from './session.service';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Marks an endpoint as reachable without authentication.
 *
 * The guard is applied globally, so protection is the default and this is the
 * deliberate, greppable exception. The inverse arrangement — remembering to
 * add a guard to each protected route — fails open: one forgotten decorator
 * exposes data. This one fails closed: one forgotten decorator produces a 401
 * that is noticed immediately.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthenticatedRequest {
  session?: AuthenticatedSession;
}

/**
 * Injects the authenticated user into a handler parameter.
 *
 * Reads what AuthGuard already attached to the request; it never performs a
 * lookup of its own, so there is exactly one place where a request becomes
 * authenticated.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.session?.user;
});

/** Injects the full session record, for handlers that need the token's metadata. */
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.session;
});
