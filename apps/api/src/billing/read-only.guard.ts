import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { SubscriptionStatus } from '@platform/shared';
import { IS_PUBLIC_KEY } from '../auth/auth.decorators';
import type { FastifyRequest } from '../auth/fastify.types';
import { ALLOWS_READ_ONLY_KEY, type SubscriptionRequest } from './billing.decorators';

/**
 * Methods that change something. Everything else is a read.
 *
 * Enforcing by HTTP method rather than by annotating every endpoint means a
 * new module added in a later phase is covered the day it ships, without
 * anyone remembering to opt in. The cost is that the rule is coarse — which is
 * the right trade for a safety net.
 */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Narrows a lapsed subscription to read-only.
 *
 * The customer keeps full sight of their data — reports, customer records,
 * schedules — and simply cannot change anything until they are paying again.
 * A hard lockout would turn a failed card into a churned account, and a
 * customer who cannot reach their data has no reason to come back.
 *
 * Runs last, after entitlement, so the more specific errors (not
 * authenticated, wrong organization, module not enabled) are reported first.
 */
@Injectable()
export class ReadOnlyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & SubscriptionRequest>();
    const subscription = request.subscription;

    // No subscription resolved means no tenant context — an endpoint that
    // opted out of tenancy, such as /auth/me. Nothing to enforce.
    if (!subscription) return true;

    if (subscription.accessLevel !== 'read-only') return true;

    const method = (request as { method?: string }).method ?? 'GET';
    if (!MUTATING_METHODS.has(method.toUpperCase())) return true;

    // A customer must ALWAYS be able to pay their way out. Locking the billing
    // endpoints behind the lapse they are trying to fix would be a trap.
    const allowsReadOnly = this.reflector.getAllAndOverride<boolean>(ALLOWS_READ_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (allowsReadOnly) return true;

    throw new ForbiddenException({
      statusCode: 403,
      code: 'SUBSCRIPTION_READ_ONLY',
      status: subscription.status satisfies SubscriptionStatus,
      message: this.messageFor(subscription.status),
    });
  }

  private messageFor(status: SubscriptionStatus): string {
    if (status === 'CANCELLED') {
      return 'Your subscription has ended. Your data is still here and you can export it, but changes are paused until you resubscribe.';
    }

    return 'Your subscription is not active, so the account is read-only. Update your billing details to make changes again.';
  }
}
