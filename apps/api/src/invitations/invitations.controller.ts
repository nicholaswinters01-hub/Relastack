import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { TenantContext } from '@platform/db';
import {
  PERMISSIONS,
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  type CreateInvitationResponse,
  type InvitationPreview,
  type InvitationsResponse,
} from '@platform/shared';
import { Public } from '../auth/auth.decorators';
import { CookieService } from '../auth/cookie.service';
import type { FastifyReply, FastifyRequest } from '../auth/fastify.types';
import { SessionService } from '../auth/session.service';
import { clientIpOf } from '../common/internal-gate';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SERVER_ENV, type ServerEnv } from '../config.provider';
import type { PermissionSet } from '../rbac/permission-set';
import {
  CurrentMembershipId,
  CurrentPermissions,
  RequirePermissionAnywhere,
} from '../rbac/rbac.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { InvitationsService } from './invitations.service';

@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly sessions: SessionService,
    private readonly cookies: CookieService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  /** Where accept links point. The first configured CORS origin is the app. */
  private webBaseUrl(): string {
    return this.env.CORS_ORIGINS[0] ?? 'http://localhost:3000';
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissionAnywhere(PERMISSIONS.MEMBER_INVITE)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentPermissions() permissions: PermissionSet,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(createInvitationRequestSchema)) body: CreateInvitationRequest,
  ): Promise<CreateInvitationResponse> {
    return this.invitations.create(tenant, permissions, membershipId, body, this.webBaseUrl());
  }

  @Get()
  @RequirePermissionAnywhere(PERMISSIONS.MEMBER_INVITE)
  async list(@CurrentTenant() tenant: TenantContext): Promise<InvitationsResponse> {
    return { invitations: await this.invitations.list(tenant) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissionAnywhere(PERMISSIONS.MEMBER_INVITE)
  async revoke(@CurrentTenant() tenant: TenantContext, @Param('id') id: string): Promise<void> {
    await this.invitations.revoke(tenant, id);
  }

  /**
   * Preview an invitation before accepting.
   *
   * Public: the invitee has no account yet, by definition. Rate limited
   * because the token is the only thing protecting it — without a limit this
   * would be a free oracle for guessing tokens.
   */
  @Public()
  @Get('preview')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async preview(@Query('token') token: string): Promise<InvitationPreview> {
    return this.invitations.preview(token ?? '');
  }

  /**
   * Accept an invitation, and sign the person in.
   *
   * Public for the same reason as preview. Signing them in immediately avoids
   * a pointless second step: they have just proven possession of the token and,
   * for a new account, chosen the password.
   */
  @Public()
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async accept(
    @Body(new ZodValidationPipe(acceptInvitationRequestSchema)) body: AcceptInvitationRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ success: true }> {
    const { userId } = await this.invitations.accept(body);

    const userAgent = request.headers['user-agent'];
    const session = await this.sessions.issue(userId, {
      ipAddress: clientIpOf(request),
      userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
    });

    this.cookies.setSession(reply, session.token, session.expiresAt);

    return { success: true };
  }
}
