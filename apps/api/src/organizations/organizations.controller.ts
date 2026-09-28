import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Put } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  PERMISSIONS,
  setMemberPackFieldsRequestSchema,
  updateOrganizationRequestSchema,
  type SetMemberPackFieldsRequest,
  type OrganizationMembersResponse,
  type OrganizationResponse,
  type SetupProgress,
  type UpdateOrganizationRequest,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { PermissionSet } from '../rbac/permission-set';
import {
  CurrentMembershipId,
  CurrentPermissions,
  RequirePermission,
} from '../rbac/rbac.decorators';
import { EnabledModules } from '../modules/module.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { OrganizationsService } from './organizations.service';

/**
 * Organization endpoints.
 *
 * Every handler receives tenant context from the guard and passes it to the
 * service, which scopes the database transaction. No handler decides for
 * itself which organization it is acting on.
 */
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get('current')
  async current(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
  ): Promise<OrganizationResponse> {
    return {
      organization: await this.organizations.getCurrent(tenant),
      roles: [...permissions.roleKeys],
      permissions: permissions.toJSON(),
      membershipId,
    };
  }

  @Patch('current')
  @RequirePermission(PERMISSIONS.ORGANIZATION_WRITE)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(updateOrganizationRequestSchema))
    body: UpdateOrganizationRequest,
  ): Promise<OrganizationResponse> {
    return {
      organization: await this.organizations.update(tenant, permissions, body),
      roles: [...permissions.roleKeys],
      permissions: permissions.toJSON(),
      membershipId,
    };
  }

  /** The "Get started" checklist. For whoever runs the business. */
  @Get('current/setup')
  @RequirePermission(PERMISSIONS.ORGANIZATION_WRITE)
  setup(@CurrentTenant() tenant: TenantContext): Promise<SetupProgress> {
    return this.organizations.setupProgress(tenant);
  }

  @Get('current/members')
  @RequirePermission(PERMISSIONS.MEMBER_READ)
  async members(@CurrentTenant() tenant: TenantContext): Promise<OrganizationMembersResponse> {
    return { members: await this.organizations.listMembers(tenant) };
  }

  /** What enabled packs record about a person, such as an applicator's license. */
  @Put('current/members/:membershipId/pack-fields')
  @RequirePermission(PERMISSIONS.MEMBER_MANAGE)
  async setMemberPackFields(
    @CurrentTenant() tenant: TenantContext,
    @EnabledModules() enabledModules: Set<string> | undefined,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body(new ZodValidationPipe(setMemberPackFieldsRequestSchema)) body: SetMemberPackFieldsRequest,
  ): Promise<{ packFields: Record<string, unknown> }> {
    return {
      packFields: await this.organizations.setMemberPackFields(
        tenant,
        enabledModules ?? new Set(),
        membershipId,
        body.packFields,
      ),
    };
  }

  /**
   * Fetch an organization by id.
   *
   * Exists primarily as an isolation surface: asking for another tenant's id
   * must return 404, identical to asking for one that does not exist. The
   * isolation suite asserts exactly that.
   */
  @Get(':id')
  async byId(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id') id: string,
  ): Promise<OrganizationResponse> {
    return {
      organization: await this.organizations.getById(tenant, id),
      roles: [...permissions.roleKeys],
      permissions: permissions.toJSON(),
      membershipId,
    };
  }
}
