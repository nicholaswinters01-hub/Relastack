import { Controller, Get, Header, Query } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  pestRecordsQuerySchema,
  type PestRecordsQuery,
  type PestRecordsResponse,
} from '@platform/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RequireModule } from '../../modules/module.decorators';
import {
  CurrentMembershipId,
  CurrentPermissions,
  RequirePermissionAnywhere,
} from '../../rbac/rbac.decorators';
import type { PermissionSet } from '../../rbac/permission-set';
import { CurrentTenant } from '../../tenancy/tenant.decorators';
import { PestRecordsService } from './pest-records.service';

/**
 * The Pest Control pack's own routes. Transport only.
 *
 * Switching the pack off refuses these, and hides nothing it recorded: the
 * rows stay where they are for when it comes back.
 */
@Controller('packs/pest-control')
@RequireModule(MODULES.PEST_CONTROL)
export class PestControlController {
  constructor(private readonly records: PestRecordsService) {}

  @Get('records')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_READ)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Query(new ZodValidationPipe(pestRecordsQuerySchema)) query: PestRecordsQuery,
  ): Promise<PestRecordsResponse> {
    return { records: await this.records.list(tenant, permissions, membershipId, query) };
  }

  /** The same records as a spreadsheet, for an inspection or an audit. */
  @Get('records.csv')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_READ)
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="application-records.csv"')
  csv(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Query(new ZodValidationPipe(pestRecordsQuerySchema)) query: PestRecordsQuery,
  ): Promise<string> {
    return this.records.csv(tenant, permissions, membershipId, query);
  }
}
