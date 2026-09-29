import { Controller, Get, Query } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  PERMISSIONS,
  performanceQuerySchema,
  type MyPerformanceResponse,
  type PerformanceQuery,
  type PerformanceResponse,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { EnabledModules } from '../modules/module.decorators';
import {
  CurrentMembershipId,
  CurrentPermissions,
  RequirePermissionAnywhere,
} from '../rbac/rbac.decorators';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { PerformanceService } from './performance.service';

/**
 * How people are doing. Transport only. Not gated by one module: each measure
 * is offered by the service only when its module is on.
 */
@Controller('performance')
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.MEMBER_REVIEW)
  team(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @EnabledModules() enabledModules: Set<string> | undefined,
    @Query(new ZodValidationPipe(performanceQuerySchema)) query: PerformanceQuery,
  ): Promise<PerformanceResponse> {
    return this.performance.team(tenant, permissions, enabledModules ?? new Set(), query);
  }

  /** Anyone's own numbers, and only theirs. */
  @Get('me')
  mine(
    @CurrentTenant() tenant: TenantContext,
    @CurrentMembershipId() membershipId: string,
    @EnabledModules() enabledModules: Set<string> | undefined,
    @Query(new ZodValidationPipe(performanceQuerySchema)) query: PerformanceQuery,
  ): Promise<MyPerformanceResponse> {
    return this.performance.mine(tenant, membershipId, enabledModules ?? new Set(), query);
  }
}
