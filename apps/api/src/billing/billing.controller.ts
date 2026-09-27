import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  PERMISSIONS,
  billingEventRequestSchema,
  changePlanRequestSchema,
  type BillingEventRequest,
  type ChangePlanRequest,
  type PlansResponse,
  type SubscriptionResponse,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../rbac/rbac.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { AllowsWhenReadOnly } from './billing.decorators';
import { BillingService } from './billing.service';

/**
 * Subscription and plan management.
 *
 * Belongs to core, so it is never gated by @RequireModule — an organization
 * must always be able to reach the screen that fixes its billing.
 *
 * The write endpoints carry @AllowsWhenReadOnly for the same reason: a
 * customer whose card failed must be able to choose a plan and pay. Locking
 * that behind the lapse they are trying to fix would be a trap of our own
 * making.
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('subscription')
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async subscription(@CurrentTenant() tenant: TenantContext): Promise<SubscriptionResponse> {
    const [subscription, summary] = await Promise.all([
      this.billing.getSubscription(tenant),
      this.billing.getSummary(tenant),
    ]);

    return { subscription, summary, account: await this.billing.getAccount(tenant) };
  }

  /** The public price list. Any member may see what the company could move to. */
  @Get('plans')
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async plans(): Promise<PlansResponse> {
    return { plans: await this.billing.listPlans() };
  }

  @Post('plan')
  @HttpCode(HttpStatus.OK)
  @AllowsWhenReadOnly()
  @RequirePermission(PERMISSIONS.ORGANIZATION_WRITE)
  async changePlan(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(changePlanRequestSchema)) body: ChangePlanRequest,
  ): Promise<SubscriptionResponse> {
    const subscription = await this.billing.changePlan(tenant, body.planKey);

    return {
      subscription,
      summary: await this.billing.getSummary(tenant),
      account: await this.billing.getAccount(tenant),
    };
  }

  /**
   * Apply a billing event.
   *
   * Development stand-in for provider webhooks until Phase 18. It exists so
   * the lapse-and-recover path can be exercised end to end without a payment
   * provider — and the transitions it drives are the same ones a real webhook
   * will drive.
   */
  @Post('events')
  @HttpCode(HttpStatus.OK)
  @AllowsWhenReadOnly()
  @RequirePermission(PERMISSIONS.ORGANIZATION_WRITE)
  async applyEvent(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(billingEventRequestSchema)) body: BillingEventRequest,
  ): Promise<SubscriptionResponse> {
    const subscription = await this.billing.applyEvent(tenant, body.event);

    return {
      subscription,
      summary: await this.billing.getSummary(tenant),
      account: await this.billing.getAccount(tenant),
    };
  }
}
