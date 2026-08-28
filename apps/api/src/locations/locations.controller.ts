import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  PERMISSIONS,
  assignLocationMemberRequestSchema,
  createLocationRequestSchema,
  updateLocationRequestSchema,
  type AssignLocationMemberRequest,
  type CreateLocationRequest,
  type LocationMembersResponse,
  type LocationResponse,
  type LocationsResponse,
  type UpdateLocationRequest,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentPermissions,
  RequirePermission,
  RequirePermissionAnywhere,
} from '../rbac/rbac.decorators';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { LocationsService } from './locations.service';

/**
 * Location endpoints.
 *
 * `@RequirePermission` covers organization-wide checks that can be decided
 * from the route alone. Anything scoped to a particular location is checked in
 * the service with `hasAt`, because which location is involved only becomes
 * known from the path or body — a route-level decorator could not tell a
 * Location Manager's own branch from someone else's.
 *
 * Validation pipes are attached to individual @Body parameters, not to
 * handlers: @UsePipes applies to EVERY parameter, including custom decorators
 * like @CurrentPermissions.
 */
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  // Anywhere, not organization-wide: an Employee scoped to two branches
  // must be able to list those two. The service narrows the results.
  @RequirePermissionAnywhere(PERMISSIONS.LOCATION_READ)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
  ): Promise<LocationsResponse> {
    return { locations: await this.locations.list(tenant, permissions) };
  }

  /**
   * Creating a location adds a billable unit, so it requires the permission
   * organization-wide. A Location Manager runs branches; they do not open new
   * ones.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PERMISSIONS.LOCATION_WRITE)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Body(new ZodValidationPipe(createLocationRequestSchema)) body: CreateLocationRequest,
  ): Promise<LocationResponse> {
    return { location: await this.locations.create(tenant, permissions, body) };
  }

  @Get(':id')
  async byId(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id') id: string,
  ): Promise<LocationResponse> {
    return { location: await this.locations.getById(tenant, permissions, id) };
  }

  /** Scope-checked in the service: editable at locations the caller runs. */
  @Patch(':id')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateLocationRequestSchema)) body: UpdateLocationRequest,
  ): Promise<LocationResponse> {
    return { location: await this.locations.update(tenant, permissions, id, body) };
  }

  @Get(':id/members')
  async members(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id') id: string,
  ): Promise<LocationMembersResponse> {
    return { members: await this.locations.listMembers(tenant, permissions, id) };
  }

  @Post(':id/members')
  @HttpCode(HttpStatus.OK)
  async assign(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignLocationMemberRequestSchema))
    body: AssignLocationMemberRequest,
  ): Promise<LocationMembersResponse> {
    return {
      members: await this.locations.assignMember(tenant, permissions, id, body.membershipId),
    };
  }

  @Delete(':id/members/:membershipId')
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id') id: string,
    @Param('membershipId') membershipId: string,
  ): Promise<LocationMembersResponse> {
    return {
      members: await this.locations.removeMember(tenant, permissions, id, membershipId),
    };
  }
}
