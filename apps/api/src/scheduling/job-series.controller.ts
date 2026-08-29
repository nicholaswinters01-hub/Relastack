import {
  Body,
  Controller,
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
  createJobSeriesRequestSchema,
  updateJobSeriesRequestSchema,
  type CreateJobSeriesRequest,
  type JobSeriesListResponse,
  type JobSeriesResponse,
  type UpdateJobSeriesRequest,
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
import { JobSeriesService } from './job-series.service';

/**
 * Repeating work.
 *
 * These endpoints are "all future visits". Changing ONE visit is a PATCH on
 * that job, which detaches it and puts it permanently out of reach of the
 * series — the split people expect from a calendar, expressed as two different
 * resources rather than a mode flag.
 */
@Controller('job-series')
@RequireModule(MODULES.SCHEDULING)
export class JobSeriesController {
  constructor(private readonly series: JobSeriesService) {}

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.JOB_READ)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
  ): Promise<JobSeriesListResponse> {
    return { series: await this.series.list(tenant, permissions) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.JOB_WRITE)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(createJobSeriesRequestSchema)) body: CreateJobSeriesRequest,
  ): Promise<JobSeriesResponse> {
    const { series, booked } = await this.series.create(tenant, permissions, membershipId, body);

    return { series, booked, released: 0 };
  }

  @Get(':id')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_READ)
  async byId(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobSeriesResponse> {
    return {
      series: await this.series.getById(tenant, permissions, id),
      booked: 0,
      released: 0,
    };
  }

  @Patch(':id')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_WRITE)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateJobSeriesRequestSchema)) body: UpdateJobSeriesRequest,
  ): Promise<JobSeriesResponse> {
    return this.series.update(tenant, permissions, id, body);
  }

  /** Stop producing visits. Everything already booked stays put. */
  @Post(':id/stop')
  @HttpCode(HttpStatus.OK)
  @RequirePermissionAnywhere(PERMISSIONS.JOB_WRITE)
  async stop(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobSeriesResponse> {
    const { series, released } = await this.series.stop(tenant, permissions, id);

    return { series, booked: 0, released };
  }
}
