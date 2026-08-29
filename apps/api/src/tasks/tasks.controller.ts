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
  PERMISSIONS,
  createTaskRequestSchema,
  taskQuerySchema,
  updateTaskRequestSchema,
  type CreateTaskRequest,
  type TaskQuery,
  type TaskResponse,
  type TasksResponse,
  type UpdateTaskRequest,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentMembershipId,
  CurrentPermissions,
  RequirePermissionAnywhere,
} from '../rbac/rbac.decorators';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { TasksService } from './tasks.service';

/**
 * Task endpoints.
 *
 * No @RequireModule: tasks are part of core, so they are available on every
 * plan. Scheduling and Automation are both built on top of them, and gating
 * the foundation would mean gating everything that stands on it.
 *
 * Every handler takes the caller's membership id, because task visibility
 * depends on who you are and not only on what you may do — a task assigned to
 * you is visible wherever it sits.
 */
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.TASK_READ)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Query(new ZodValidationPipe(taskQuerySchema)) query: TaskQuery,
  ): Promise<TasksResponse> {
    return this.tasks.list(tenant, permissions, membershipId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.TASK_WRITE)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(createTaskRequestSchema)) body: CreateTaskRequest,
  ): Promise<TaskResponse> {
    return { task: await this.tasks.create(tenant, permissions, membershipId, body) };
  }

  @Get(':id')
  @RequirePermissionAnywhere(PERMISSIONS.TASK_READ)
  async byId(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TaskResponse> {
    return { task: await this.tasks.getById(tenant, permissions, membershipId, id) };
  }

  /**
   * Only TASK_READ at the route.
   *
   * Whoever a task is assigned to may move its status whatever their role, so
   * a route-level write requirement would refuse exactly the person the work
   * was given to. The service draws the real line: assignees may change the
   * status and nothing else.
   */
  @Patch(':id')
  @RequirePermissionAnywhere(PERMISSIONS.TASK_READ)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateTaskRequestSchema)) body: UpdateTaskRequest,
  ): Promise<TaskResponse> {
    return { task: await this.tasks.update(tenant, permissions, membershipId, id, body) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.TASK_DELETE)
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.tasks.remove(tenant, permissions, membershipId, id);
  }
}
