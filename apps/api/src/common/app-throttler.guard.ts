import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { SERVER_ENV, type ServerEnv } from '../config.provider';
import { clientIpOf } from './internal-gate';

/**
 * ThrottlerGuard with a configurable off switch.
 *
 * The switch is read from injected configuration when the guard is
 * constructed, not when this module is loaded. That distinction matters: a
 * module-scope `loadServerEnv()` is evaluated during import, and ES module
 * imports are hoisted above every other statement in a file — so a test that
 * sets `process.env` at the top of itself would still be too late to affect
 * it. Reading at injection time makes the behaviour depend on configuration
 * rather than on module evaluation order.
 *
 * Configuration forbids disabling rate limiting in production, so this switch
 * cannot be used to weaken a deployed system.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {
    super(options, storageService, reflector);
  }

  /** Per real client. Every request arrives from the web tier, so the socket address alone would lump everyone together. */
  protected override async getTracker(request: Record<string, unknown>): Promise<string> {
    return clientIpOf(request);
  }

  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (!this.env.RATE_LIMIT_ENABLED) return true;

    return super.shouldSkip(context);
  }
}
