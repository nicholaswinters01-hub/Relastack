import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  MODULES,
  PERMISSIONS,
  boardQuerySchema,
  createHelpRequestSchema,
  type BoardQuery,
  type BoardResponse,
  type CreateHelpRequest,
  type HelpRequest,
  type JobHelpResponse,
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
import { BoardService } from './board.service';

/**
 * The manager's board and "Need a manager". Transport only.
 *
 * The board needs job.write somewhere, narrowed to those branches by the
 * service. Calls follow the job's own visibility, with the crew calling and
 * the branch's managers answering.
 */
@Controller()
@RequireModule(MODULES.SCHEDULING)
export class BoardController {
  constructor(private readonly board: BoardService) {}

  @Get('board')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_WRITE)
  get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Query(new ZodValidationPipe(boardQuerySchema)) query: BoardQuery,
  ): Promise<BoardResponse> {
    return this.board.board(tenant, permissions, query);
  }

  @Get('jobs/:id/help')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_READ)
  jobHelp(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobHelpResponse> {
    return this.board.jobHelp(tenant, permissions, membershipId, id);
  }

  @Post('jobs/:id/help')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.JOB_READ)
  requestHelp(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createHelpRequestSchema)) body: CreateHelpRequest,
  ): Promise<HelpRequest> {
    return this.board.requestHelp(tenant, permissions, membershipId, id, body.note);
  }

  @Post('help-requests/:id/acknowledge')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_WRITE)
  acknowledge(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<HelpRequest> {
    return this.board.acknowledge(tenant, permissions, membershipId, id);
  }

  @Post('help-requests/:id/resolve')
  @RequirePermissionAnywhere(PERMISSIONS.JOB_READ)
  resolve(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<HelpRequest> {
    return this.board.resolve(tenant, permissions, membershipId, id);
  }
}
