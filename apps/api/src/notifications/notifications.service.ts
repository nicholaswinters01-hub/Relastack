import { BadRequestException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@platform/db';
import {
  NOTIFIABLE,
  type MarkReadRequest,
  type Notification,
  type NotificationPreference,
  type NotificationQuery,
  type UpdatePreferenceRequest,
} from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A person's own notifications.
 *
 * No permission checks here, and none are missing: every query is keyed on the
 * caller's own membership id. There is no reading somebody else's inbox
 * because there is no parameter that would let you ask.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    context: TenantContext,
    membershipId: string,
    query: NotificationQuery,
  ): Promise<{ notifications: Notification[]; unread: number }> {
    const { rows, unread } = await this.prisma.withTenant(context, async (tx) => ({
      rows: await tx.notification.findMany({
        where: { membershipId, ...(query.unreadOnly ? { readAt: null } : {}) },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
      }),
      // Counted separately from the page, so the badge is right even when the
      // list is truncated.
      unread: await tx.notification.count({ where: { membershipId, readAt: null } }),
    }));

    return {
      notifications: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        linkPath: row.linkPath,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      unread,
    };
  }

  /** Empty ids marks everything read, which is the button people press. */
  async markRead(
    context: TenantContext,
    membershipId: string,
    input: MarkReadRequest,
  ): Promise<number> {
    const result = await this.prisma.withTenant(context, (tx) =>
      tx.notification.updateMany({
        where: {
          membershipId,
          readAt: null,
          ...(input.ids.length > 0 ? { id: { in: input.ids } } : {}),
        },
        data: { readAt: new Date() },
      }),
    );

    return result.count;
  }

  /**
   * Every notifiable type, with what this person has chosen.
   *
   * Built from the catalogue rather than from stored rows, so a type added in
   * a later phase appears immediately with its default rather than only for
   * people who happen to have a row.
   */
  async preferences(
    context: TenantContext,
    membershipId: string,
  ): Promise<NotificationPreference[]> {
    const stored = await this.prisma.withTenant(context, (tx) =>
      tx.notificationPreference.findMany({ where: { membershipId } }),
    );

    const byType = new Map(stored.map((row) => [row.type, row]));

    return NOTIFIABLE.map((entry) => ({
      type: entry.type,
      label: entry.label,
      description: entry.description,
      inApp: byType.get(entry.type)?.inApp ?? true,
      email: byType.get(entry.type)?.email ?? true,
    }));
  }

  /**
   * Store one exception to the defaults.
   *
   * The type is checked against the catalogue rather than taken on trust. A
   * typo would otherwise be accepted, stored, and silently ignored forever,
   * because `preferences` reads the catalogue and would never look at the row
   * — somebody would believe they had turned something off and keep getting
   * it. Note that not every event type is here: subscription.read_only has no
   * entry, so losing access to your own account always reaches you.
   */
  async setPreference(
    context: TenantContext,
    membershipId: string,
    input: UpdatePreferenceRequest,
  ): Promise<NotificationPreference[]> {
    if (!NOTIFIABLE.some((entry) => entry.type === input.type)) {
      throw new BadRequestException(`Unknown notification type: ${input.type}`);
    }

    await this.prisma.withTenant(context, (tx) =>
      tx.notificationPreference.upsert({
        where: { membershipId_type: { membershipId, type: input.type } },
        create: {
          membershipId,
          organizationId: context.organizationId,
          type: input.type,
          inApp: input.inApp,
          email: input.email,
        },
        update: { inApp: input.inApp, email: input.email },
      }),
    );

    return this.preferences(context, membershipId);
  }
}
