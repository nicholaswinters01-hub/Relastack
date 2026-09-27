import { Injectable, NotFoundException } from '@nestjs/common';
import {
  EVENT_TYPES,
  type StaffSupportDetail,
  type StaffSupportQuery,
  type StaffSupportSummary,
  type SupportStatus,
} from '@platform/shared';
import { DispatcherService } from '../notifications/dispatcher.service';
import { PrismaService } from '../prisma/prisma.service';
import { toSupportMessage, toSupportSummary } from '../support/support.service';
import { recordStaffEvent } from './staff-audit';
import type { StaffIdentity } from './staff.decorators';

const FILTER_STATUS: Record<StaffSupportQuery['filter'], SupportStatus[] | null> = {
  open: ['OPEN'],
  waiting: ['WAITING_ON_CUSTOMER'],
  resolved: ['RESOLVED'],
  all: null,
};

/**
 * The staff inbox for help requests.
 *
 * Through withStaff, whose policies reach these two tables and the account
 * tables, and still no customer data. A reply is recorded, audited, and
 * announced to the person who asked, all in one transaction; the outbox then
 * emails them, retrying if the mail provider is down.
 */
@Injectable()
export class StaffSupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: DispatcherService,
  ) {}

  async list(staff: StaffIdentity, query: StaffSupportQuery): Promise<StaffSupportSummary[]> {
    const statuses = FILTER_STATUS[query.filter];

    const requests = await this.prisma.withStaff(staff.userId, (tx) =>
      tx.supportRequest.findMany({
        where: statuses ? { status: { in: statuses } } : {},
        orderBy: { updatedAt: 'desc' },
        take: 200,
        include: { organization: { select: { name: true } } },
      }),
    );

    return requests.map((request) => ({
      ...toSupportSummary(request),
      organizationId: request.organizationId,
      businessName: request.organization.name,
    }));
  }

  async detail(staff: StaffIdentity, requestId: string): Promise<StaffSupportDetail> {
    const request = await this.prisma.withStaff(staff.userId, (tx) =>
      tx.supportRequest.findUnique({
        where: { id: requestId },
        include: {
          organization: { select: { name: true } },
          messages: { orderBy: { createdAt: 'asc' } },
        },
      }),
    );
    if (!request) throw new NotFoundException();

    return {
      ...toSupportSummary(request),
      organizationId: request.organizationId,
      businessName: request.organization.name,
      // Staff see who on the team wrote each reply; the business sees "RelaStack".
      messages: request.messages.map((message) => ({
        ...toSupportMessage(message),
        authorLabel: message.authorEmail,
      })),
    };
  }

  async reply(
    staff: StaffIdentity,
    requestId: string,
    body: string,
    status: SupportStatus = 'WAITING_ON_CUSTOMER',
  ): Promise<void> {
    await this.prisma.withStaff(staff.userId, async (tx) => {
      const request = await tx.supportRequest.findUnique({ where: { id: requestId } });
      if (!request) throw new NotFoundException();

      await tx.supportMessage.create({
        data: {
          requestId,
          organizationId: request.organizationId,
          authorUserId: staff.userId,
          authorEmail: staff.email,
          fromStaff: true,
          body,
        },
      });

      await tx.supportRequest.update({
        where: { id: requestId },
        data: { status, resolvedAt: status === 'RESOLVED' ? new Date() : null },
      });

      // Addressed to whoever asked, if they are still in the business.
      const membership = await tx.organizationMembership.findUnique({
        where: {
          userId_organizationId: {
            userId: request.openedByUserId,
            organizationId: request.organizationId,
          },
        },
        select: { id: true },
      });

      if (membership) {
        // Raw, without RETURNING: staff may insert this one event type and
        // cannot read the events table back, which Prisma's create would try.
        await tx.$executeRaw`
          INSERT INTO domain_events (id, organization_id, type, payload)
          VALUES (gen_random_uuid(), ${request.organizationId}::uuid, ${EVENT_TYPES.SUPPORT_REPLIED},
            ${JSON.stringify({ requestId, membershipId: membership.id, subject: request.subject })}::jsonb)`;
      }

      await recordStaffEvent(tx, staff, request.organizationId, 'support.replied', null, {
        requestId,
        status,
        length: body.length,
      });
    });

    this.dispatcher.nudge();
  }

  async setStatus(staff: StaffIdentity, requestId: string, status: SupportStatus): Promise<void> {
    await this.prisma.withStaff(staff.userId, async (tx) => {
      const request = await tx.supportRequest.findUnique({ where: { id: requestId } });
      if (!request) throw new NotFoundException();

      await tx.supportRequest.update({
        where: { id: requestId },
        data: { status, resolvedAt: status === 'RESOLVED' ? new Date() : null },
      });

      await recordStaffEvent(tx, staff, request.organizationId, 'support.status', null, {
        requestId,
        from: request.status,
        to: status,
      });
    });
  }
}
