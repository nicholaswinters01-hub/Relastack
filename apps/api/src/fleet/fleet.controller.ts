import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  completeServiceRequestSchema,
  createAssetRequestSchema,
  createReminderRequestSchema,
  fleetQuerySchema,
  logReadingRequestSchema,
  setJobVehicleRequestSchema,
  updateAssetRequestSchema,
  type AssetDetailResponse,
  type CompleteServiceRequest,
  type CreateAssetRequest,
  type CreateReminderRequest,
  type FleetAsset,
  type FleetQuery,
  type FleetResponse,
  type LogReadingRequest,
  type SetJobVehicleRequest,
  type UpdateAssetRequest,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { EnabledModules, RequireModule } from '../modules/module.decorators';
import {
  CurrentMembershipId,
  CurrentPermissions,
  RequirePermissionAnywhere,
} from '../rbac/rbac.decorators';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { FleetService } from './fleet.service';

/**
 * Fleet. Transport only.
 *
 * Gated by the Fleet module, which a business has only through a pack that
 * includes it. Authority over an asset follows its home branch and is checked
 * by the service, as is the usual driver's right to log readings.
 */
@Controller('fleet')
@RequireModule(MODULES.FLEET)
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.FLEET_READ)
  list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Query(new ZodValidationPipe(fleetQuerySchema)) query: FleetQuery,
  ): Promise<FleetResponse> {
    return this.fleet.list(tenant, permissions, membershipId, query.includeRetired === 'true');
  }

  @Get('assets/:id')
  @RequirePermissionAnywhere(PERMISSIONS.FLEET_READ)
  detail(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssetDetailResponse> {
    return this.fleet.detail(tenant, permissions, membershipId, id);
  }

  @Post('assets')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.FLEET_WRITE)
  create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(createAssetRequestSchema)) body: CreateAssetRequest,
  ): Promise<FleetAsset> {
    return this.fleet.create(tenant, permissions, membershipId, body);
  }

  @Patch('assets/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.FLEET_WRITE)
  update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateAssetRequestSchema)) body: UpdateAssetRequest,
  ): Promise<void> {
    return this.fleet.update(tenant, permissions, membershipId, id, body);
  }

  /** Managers, or the asset's usual driver. See the service for the 409. */
  @Post('assets/:id/readings')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.FLEET_READ)
  logReading(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(logReadingRequestSchema)) body: LogReadingRequest,
  ): Promise<void> {
    return this.fleet.logReading(tenant, permissions, membershipId, id, body);
  }

  @Post('assets/:id/reminders')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.FLEET_WRITE)
  createReminder(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createReminderRequestSchema)) body: CreateReminderRequest,
  ): Promise<void> {
    return this.fleet.createReminder(tenant, permissions, membershipId, id, body);
  }

  @Delete('reminders/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.FLEET_WRITE)
  removeReminder(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.fleet.removeReminder(tenant, permissions, membershipId, id);
  }

  @Post('assets/:id/services')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.FLEET_WRITE)
  completeService(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(completeServiceRequestSchema)) body: CompleteServiceRequest,
  ): Promise<void> {
    return this.fleet.completeService(tenant, permissions, membershipId, id, body);
  }

  @Delete('services/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.FLEET_WRITE)
  removeService(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.fleet.removeService(tenant, permissions, membershipId, id);
  }

  /** Needs Scheduling as well as Fleet: there is no job without it. */
  @Put('jobs/:jobId/vehicle')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_WRITE)
  setJobVehicle(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @EnabledModules() enabledModules: Set<string> | undefined,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body(new ZodValidationPipe(setJobVehicleRequestSchema)) body: SetJobVehicleRequest,
  ): Promise<{ vehicleId: string | null; vehicleName: string | null }> {
    if (!enabledModules?.has(MODULES.SCHEDULING)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'MODULE_NOT_ENABLED',
        moduleKey: MODULES.SCHEDULING,
        message: 'Scheduling is not enabled for your organization.',
      });
    }
    return this.fleet.setJobVehicle(tenant, permissions, membershipId, jobId, body);
  }
}
