import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  createTagRequestSchema,
  updateTagRequestSchema,
  type CreateTagRequest,
  type TagsResponse,
  type UpdateTagRequest,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireModule } from '../modules/module.decorators';
import { RequirePermission, RequirePermissionAnywhere } from '../rbac/rbac.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { TagsService } from './tags.service';

/**
 * The tag vocabulary.
 *
 * Reading needs only customer.read — a branch employee has to see the tags on
 * the customers they work with. Changing the vocabulary needs
 * customer.configure, held organization-wide, because renaming or deleting a
 * tag changes what every other branch sees.
 */
@Controller('tags')
@RequireModule(MODULES.CRM)
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.CUSTOMER_READ)
  async list(@CurrentTenant() tenant: TenantContext): Promise<TagsResponse> {
    return { tags: await this.tags.list(tenant) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PERMISSIONS.CUSTOMER_CONFIGURE)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(createTagRequestSchema)) body: CreateTagRequest,
  ): Promise<TagsResponse> {
    await this.tags.create(tenant, body);

    return { tags: await this.tags.list(tenant) };
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CUSTOMER_CONFIGURE)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateTagRequestSchema)) body: UpdateTagRequest,
  ): Promise<TagsResponse> {
    await this.tags.update(tenant, id, body);

    return { tags: await this.tags.list(tenant) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PERMISSIONS.CUSTOMER_CONFIGURE)
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.tags.remove(tenant, id);
  }
}
