import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireModule } from '../modules/module.decorators';
import { CurrentPermissions, RequirePermissionAnywhere } from '../rbac/rbac.decorators';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { CustomerExportService, type ExportKind } from './customer-export.service';

const BOM = String.fromCharCode(0xfeff);

const exportKindSchema = z.enum(['customers', 'contacts', 'notes']);

/** Customers, contacts and notes as spreadsheets. Transport only. */
@Controller('customers/export')
@RequireModule(MODULES.CRM)
export class CustomerExportController {
  constructor(private readonly exports: CustomerExportService) {}

  @Get(':kind')
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_EXPORT)
  @Header('cache-control', 'private, no-store')
  async csv(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('kind', new ZodValidationPipe(exportKindSchema)) kind: ExportKind,
  ): Promise<StreamableFile> {
    const csv = await this.exports.csv(tenant, permissions, kind);
    // The byte-order mark tells Excel the file is UTF-8, so accented names survive.
    return new StreamableFile(Buffer.from(BOM + csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${kind}.csv"`,
    });
  }
}
