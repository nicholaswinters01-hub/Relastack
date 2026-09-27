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
  Put,
} from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  PERMISSIONS,
  createGroupRequestSchema,
  setMemberGroupsRequestSchema,
  updateGroupRequestSchema,
  type CreateGroupRequest,
  type GroupsResponse,
  type MemberGroup,
  type SetMemberGroupsRequest,
  type UpdateGroupRequest,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../rbac/rbac.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { GroupsService } from './groups.service';

/**
 * Employee groups. Transport only.
 *
 * Reading is for whoever can see the Employees page (organization-wide
 * member.read, as the page itself requires); changing is for whoever can
 * manage people.
 */
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.MEMBER_READ)
  async list(@CurrentTenant() tenant: TenantContext): Promise<GroupsResponse> {
    return { groups: await this.groups.list(tenant) };
  }

  @Post()
  @RequirePermission(PERMISSIONS.MEMBER_MANAGE)
  create(
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodValidationPipe(createGroupRequestSchema)) body: CreateGroupRequest,
  ): Promise<MemberGroup> {
    return this.groups.create(tenant, body);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PERMISSIONS.MEMBER_MANAGE)
  update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateGroupRequestSchema)) body: UpdateGroupRequest,
  ): Promise<void> {
    return this.groups.update(tenant, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PERMISSIONS.MEMBER_MANAGE)
  remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.groups.remove(tenant, id);
  }
}

/** A person's groups, alongside the rest of their membership. */
@Controller('organizations/current/members')
export class MemberGroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Put(':membershipId/groups')
  @RequirePermission(PERMISSIONS.MEMBER_MANAGE)
  async setGroups(
    @CurrentTenant() tenant: TenantContext,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body(new ZodValidationPipe(setMemberGroupsRequestSchema)) body: SetMemberGroupsRequest,
  ): Promise<{ groupIds: string[] }> {
    return { groupIds: await this.groups.setMemberGroups(tenant, membershipId, body.groupIds) };
  }
}
