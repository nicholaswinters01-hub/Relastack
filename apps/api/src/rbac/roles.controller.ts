import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  createCustomRoleRequestSchema,
  type CreateCustomRoleRequest,
  type RolesResponse,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequireModule } from '../modules/module.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { RequirePermission } from './rbac.decorators';
import { RolesService } from './roles.service';

/**
 * Roles.
 *
 * Listing is core — every organization needs to see the built-in roles in
 * order to invite anyone. CREATING a custom role is a separate, paid
 * capability, so that handler carries `@RequireModule(CUSTOM_ROLES)`.
 *
 * This is the first place the module boundary does real work: the same
 * controller serves an always-available read and a gated write.
 */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.MEMBER_READ)
  async list(@CurrentTenant() tenant: TenantContext): Promise<RolesResponse> {
    return { roles: await this.roles.list(tenant) };
  }

  /**
   * Define a custom role.
   *
   * Gated by the Custom Roles module. Turning it off does not delete roles
   * already created — it stops new ones, exactly as a subscription downgrade
   * should. Existing data is never destroyed by a billing change.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireModule(MODULES.CUSTOM_ROLES)
  @RequirePermission(PERMISSIONS.MEMBER_MANAGE)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(createCustomRoleRequestSchema)) body: CreateCustomRoleRequest,
  ): Promise<RolesResponse> {
    await this.roles.createCustom(tenant, body);

    return { roles: await this.roles.list(tenant) };
  }
}
