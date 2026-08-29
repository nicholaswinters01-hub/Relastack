import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  createCustomFieldRequestSchema,
  updateCustomFieldRequestSchema,
  type CreateCustomFieldRequest,
  type CustomFieldsResponse,
  type UpdateCustomFieldRequest,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireModule } from '../modules/module.decorators';
import { RequirePermission, RequirePermissionAnywhere } from '../rbac/rbac.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { CustomFieldsService } from './custom-fields.service';

/**
 * Fields an organization defines for itself.
 *
 * Reading needs only customer.read: everyone filling in a customer form needs
 * to know what the fields are. Defining them needs customer.configure, because
 * adding a required field changes what every colleague must fill in.
 */
@Controller('custom-fields')
@RequireModule(MODULES.CRM)
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_READ)
  async list(@CurrentTenant() tenant: TenantContext): Promise<CustomFieldsResponse> {
    return { fields: await this.fields.list(tenant) };
  }

  /** Includes retired fields, so the configuration screen can restore one. */
  @Get('all')
  @RequirePermission(PERMISSIONS.CUSTOMER_CONFIGURE)
  async listAll(@CurrentTenant() tenant: TenantContext): Promise<CustomFieldsResponse> {
    return { fields: await this.fields.list(tenant, true) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PERMISSIONS.CUSTOMER_CONFIGURE)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(createCustomFieldRequestSchema)) body: CreateCustomFieldRequest,
  ): Promise<CustomFieldsResponse> {
    await this.fields.create(tenant, body);

    return { fields: await this.fields.list(tenant, true) };
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_CONFIGURE)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCustomFieldRequestSchema)) body: UpdateCustomFieldRequest,
  ): Promise<CustomFieldsResponse> {
    await this.fields.update(tenant, id, body);

    return { fields: await this.fields.list(tenant, true) };
  }

  /**
   * Retire a field. The values already recorded are untouched.
   *
   * DELETE rather than a separate verb because that is the button the
   * interface offers, but it is deliberately not destructive — restoring the
   * field brings the history back.
   */
  @Delete(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_CONFIGURE)
  async archive(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomFieldsResponse> {
    await this.fields.archive(tenant, id);

    return { fields: await this.fields.list(tenant, true) };
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.CUSTOMER_CONFIGURE)
  async restore(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomFieldsResponse> {
    await this.fields.restore(tenant, id);

    return { fields: await this.fields.list(tenant, true) };
  }
}
