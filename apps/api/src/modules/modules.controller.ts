import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import { PERMISSIONS, type ModulesResponse } from '@platform/shared';
import { RequirePermission } from '../rbac/rbac.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { EntitlementService } from './entitlement.service';

/**
 * Module management.
 *
 * Belongs to core, so it is never gated by @RequireModule — an organization
 * must always be able to reach the screen that turns modules on, including
 * when everything else is off.
 */
@Controller('modules')
export class ModulesController {
  constructor(private readonly entitlements: EntitlementService) {}

  /**
   * Every module, with this organization's state.
   *
   * Requires only `organization.read`: an Employee seeing which capabilities
   * the company has is harmless, and the navigation needs it.
   */
  @Get()
  @RequirePermission(PERMISSIONS.ORGANIZATION_READ)
  async list(@CurrentTenant() tenant: TenantContext): Promise<ModulesResponse> {
    return { modules: await this.entitlements.listFor(tenant) };
  }

  /**
   * Turning a module on changes what the organization pays for from Phase 6,
   * so it needs organization-wide authority — never a Location Manager's
   * scoped grant.
   */
  @Post(':key')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.ORGANIZATION_WRITE)
  async enable(
    @CurrentTenant() tenant: TenantContext,
    @Param('key') key: string,
  ): Promise<{ enabled: string[]; modules: ModulesResponse['modules'] }> {
    const enabled = await this.entitlements.enable(tenant, key);

    return { enabled, modules: await this.entitlements.listFor(tenant) };
  }

  @Delete(':key')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.ORGANIZATION_WRITE)
  async disable(
    @CurrentTenant() tenant: TenantContext,
    @Param('key') key: string,
  ): Promise<ModulesResponse> {
    await this.entitlements.disable(tenant, key);

    return { modules: await this.entitlements.listFor(tenant) };
  }
}
