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
  Query,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  createJobRequestSchema,
  jobQuerySchema,
  updateJobRequestSchema,
  type CreateJobRequest,
  type JobQuery,
  type JobResponse,
  type JobsResponse,
  type UpdateJobRequest,
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
import { JobsService } from './jobs.service';

/**
 * The schedule.
 *
 * Gated by the Scheduling module, which depends on CRM — unlike tasks, this is
 * a paid capability, so an organization without it is refused at the route
 * whatever the interface offers.
 *
 * Every handler takes the caller's membership id: a job booked onto you is
 * visible and completable wherever it sits, so who you are matters as much as
 * what you may do.
 */
@Controller('jobs')
@RequireModule(MODULES.SCHEDULING)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.JOB_READ)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Query(new ZodValidationPipe(jobQuerySchema)) query: JobQuery,
  ): Promise<JobsResponse> {
    return this.jobs.list(tenant, permissions, membershipId, query);
  }

  /**
   * Book a job.
   *
   * Answers 409 SCHEDULE_CONFLICT when somebody is already booked in an
   * overlapping window, naming who and on what. Resubmitting with
   * `acknowledgeConflicts` books it anyway — the clash is a warning a person
   * decides about, not a refusal.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.JOB_WRITE)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(createJobRequestSchema)) body: CreateJobRequest,
  ): Promise<JobResponse> {
    return { job: await this.jobs.create(tenant, permissions, membershipId, body) };
  }

  @Get(':id')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_READ)
  async byId(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobResponse> {
    return { job: await this.jobs.getById(tenant, permissions, membershipId, id) };
  }

  /**
   * Only JOB_READ at the route.
   *
   * Whoever is on the job may move its status whatever their role, so a
   * route-level write requirement would refuse exactly the crew the work was
   * given to. The service draws the real line.
   */
  @Patch(':id')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_READ)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateJobRequestSchema)) body: UpdateJobRequest,
  ): Promise<JobResponse> {
    return { job: await this.jobs.update(tenant, permissions, membershipId, id, body) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.JOB_DELETE)
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.jobs.remove(tenant, permissions, membershipId, id);
  }
}
