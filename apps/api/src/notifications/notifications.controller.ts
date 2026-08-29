import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Query } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  markReadRequestSchema,
  notificationQuerySchema,
  updatePreferenceRequestSchema,
  type MarkReadRequest,
  type NotificationQuery,
  type NotificationsResponse,
  type PreferencesResponse,
  type UpdatePreferenceRequest,
} from '@platform/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentMembershipId } from '../rbac/rbac.decorators';
import { CurrentTenant } from '../tenancy/tenant.decorators';
import { NotificationsService } from './notifications.service';

/**
 * Your own notifications.
 *
 * No @RequirePermission anywhere, and none is missing: every route is scoped
 * to the caller's own membership id. There is no permission that would let one
 * person read another's inbox because there is no parameter to ask with.
 *
 * Not module-gated either — a notification about billing has to reach an owner
 * whatever they have switched on.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentMembershipId() membershipId: string,
    @Query(new ZodValidationPipe(notificationQuerySchema)) query: NotificationQuery,
  ): Promise<NotificationsResponse> {
    return this.notifications.list(tenant, membershipId, query);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @CurrentTenant() tenant: TenantContext,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(markReadRequestSchema)) body: MarkReadRequest,
  ): Promise<NotificationsResponse> {
    await this.notifications.markRead(tenant, membershipId, body);

    return this.notifications.list(tenant, membershipId, { unreadOnly: false, limit: 30 });
  }

  @Get('preferences')
  async preferences(
    @CurrentTenant() tenant: TenantContext,
    @CurrentMembershipId() membershipId: string,
  ): Promise<PreferencesResponse> {
    return { preferences: await this.notifications.preferences(tenant, membershipId) };
  }

  @Patch('preferences')
  async setPreference(
    @CurrentTenant() tenant: TenantContext,
    @CurrentMembershipId() membershipId: string,
    @Body(new ZodValidationPipe(updatePreferenceRequestSchema)) body: UpdatePreferenceRequest,
  ): Promise<PreferencesResponse> {
    return { preferences: await this.notifications.setPreference(tenant, membershipId, body) };
  }
}
