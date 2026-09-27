import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { TenantContext, User } from '@platform/db';
import {
  openSupportRequestSchema,
  supportReplySchema,
  type OpenSupportRequest,
  type SupportReply,
  type SupportRequestDetail,
  type SupportRequestSummary,
  type SupportRequestsResponse,
} from '@platform/shared';
import { CurrentUser } from '../auth/auth.decorators';
import { AllowsWhenReadOnly } from '../billing/billing.decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { PermissionSet } from '../rbac/permission-set';
import { CurrentPermissions } from '../rbac/rbac.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { SupportService } from './support.service';

/**
 * Help, from inside a business. Transport only; the rules live in SupportService.
 *
 * No permission is required: anyone in a business may ask for help. The
 * writes carry @AllowsWhenReadOnly (rule 13): a lapsed business must still be
 * able to ask how to get back.
 */
@Controller('support/requests')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
  ): Promise<SupportRequestsResponse> {
    return { requests: await this.support.list(tenant, permissions) };
  }

  @Post()
  @AllowsWhenReadOnly()
  open(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(openSupportRequestSchema)) body: OpenSupportRequest,
  ): Promise<SupportRequestSummary> {
    return this.support.open(tenant, user.email, body);
  }

  @Get(':id')
  detail(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupportRequestDetail> {
    return this.support.detail(tenant, permissions, id);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AllowsWhenReadOnly()
  reply(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(supportReplySchema)) body: SupportReply,
  ): Promise<void> {
    return this.support.reply(tenant, permissions, user.email, id, body.body);
  }
}
