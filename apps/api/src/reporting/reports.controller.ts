import { Controller, Get, Query } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  reportRangeSchema,
  type DashboardResponse,
  type ReportRange,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireModule } from '../modules/module.decorators';
import {
  CurrentMembershipId,
  CurrentPermissions,
  RequirePermissionAnywhere,
} from '../rbac/rbac.decorators';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { ReportsService } from './reports.service';

/**
 * Reporting.
 *
 * Gated by the Reporting module. Every number inside is additionally narrowed
 * by what the reader may see: a Location Manager gets their branches, and the
 * response says so rather than implying a company-wide total.
 */
@Controller('reports')
@RequireModule(MODULES.REPORTING)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('dashboard')
  // Anywhere, not organization-wide. A Location Manager holds
  // organization.read only at their branches, so `has` would refuse them
  // outright and they would never reach the scoping that narrows the numbers.
  @RequirePermissionAnywhere(PERMISSIONS.ORGANIZATION_READ)
  async dashboard(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Query(new ZodValidationPipe(reportRangeSchema)) range: ReportRange,
  ): Promise<DashboardResponse> {
    return {
      dashboard: await this.reports.dashboard(tenant, permissions, membershipId, range),
    };
  }
}
