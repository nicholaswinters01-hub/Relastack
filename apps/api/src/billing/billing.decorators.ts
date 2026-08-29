import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ResolvedSubscription } from './billing.service';

export const ALLOWS_READ_ONLY_KEY = 'billing:allowsReadOnly';

/**
 * Permits a write even when the subscription is read-only.
 *
 * For the billing endpoints themselves, and nothing else. A customer whose
 * card failed must be able to choose a plan and pay — locking that behind the
 * lapse they are trying to fix would be a trap of our own making.
 *
 * Greppable on purpose: `grep AllowsWhenReadOnly` should return a very short
 * list, and any growth in it deserves scrutiny.
 */
export const AllowsWhenReadOnly = () => SetMetadata(ALLOWS_READ_ONLY_KEY, true);

export interface SubscriptionRequest {
  /**
   * Null when the organization has no subscription at all — which should not
   * happen, since registration creates one, but the type keeps that case
   * visible rather than pretending it cannot occur.
   */
  subscription?: ResolvedSubscription | null;
}

/** Injects the caller's resolved subscription. */
export const CurrentSubscription = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<SubscriptionRequest>();
  return request.subscription;
});
