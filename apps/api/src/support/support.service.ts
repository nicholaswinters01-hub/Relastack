import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, TenantContext } from '@platform/db';
import {
  PERMISSIONS,
  SUPPORT_REQUESTS_PER_DAY,
  type OpenSupportRequest,
  type SupportMessage,
  type SupportRequestDetail,
  type SupportRequestSummary,
} from '@platform/shared';
import { SERVER_ENV, type ServerEnv } from '../config.provider';
import { EmailService } from '../notifications/email.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

const DAY = 24 * 60 * 60 * 1000;

/** How a staff reply is signed to a business: the team, not a personal address. */
export const STAFF_AUTHOR_LABEL = 'RelaStack';

export function toSupportMessage(message: {
  id: string;
  fromStaff: boolean;
  authorEmail: string;
  body: string;
  createdAt: Date;
}): SupportMessage {
  return {
    id: message.id,
    fromStaff: message.fromStaff,
    authorLabel: message.fromStaff ? STAFF_AUTHOR_LABEL : message.authorEmail,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  };
}

export function toSupportSummary(request: {
  id: string;
  kind: SupportRequestSummary['kind'];
  subject: string;
  status: SupportRequestSummary['status'];
  openedByEmail: string;
  createdAt: Date;
  updatedAt: Date;
}): SupportRequestSummary {
  return {
    id: request.id,
    kind: request.kind,
    subject: request.subject,
    status: request.status,
    openedByEmail: request.openedByEmail,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

/**
 * The help desk, as a business sees it.
 *
 * Row-level security keeps each business to its own requests. Within one, a
 * request is shown to whoever opened it and to people with organization-wide
 * `organization.write`; anyone else is answered 404, as if it did not exist.
 *
 * Reachable while read-only: someone who cannot work out why their account
 * stopped letting them change things is exactly who needs to ask.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  private visibleTo(
    context: TenantContext,
    permissions: PermissionSet,
  ): Prisma.SupportRequestWhereInput {
    return permissions.has(PERMISSIONS.ORGANIZATION_WRITE)
      ? {}
      : { openedByUserId: context.userId };
  }

  async list(context: TenantContext, permissions: PermissionSet): Promise<SupportRequestSummary[]> {
    const requests = await this.prisma.withTenant(context, (tx) =>
      tx.supportRequest.findMany({
        where: this.visibleTo(context, permissions),
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    );

    return requests.map(toSupportSummary);
  }

  async detail(
    context: TenantContext,
    permissions: PermissionSet,
    requestId: string,
  ): Promise<SupportRequestDetail> {
    const request = await this.prisma.withTenant(context, (tx) =>
      tx.supportRequest.findFirst({
        where: { AND: [{ id: requestId }, this.visibleTo(context, permissions)] },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      }),
    );
    if (!request) throw new NotFoundException();

    return { ...toSupportSummary(request), messages: request.messages.map(toSupportMessage) };
  }

  async open(
    context: TenantContext,
    email: string,
    input: OpenSupportRequest,
  ): Promise<SupportRequestSummary> {
    const { request, businessName } = await this.prisma.withTenant(context, async (tx) => {
      const today = await tx.supportRequest.count({
        where: {
          organizationId: context.organizationId,
          createdAt: { gt: new Date(Date.now() - DAY) },
        },
      });
      if (today >= SUPPORT_REQUESTS_PER_DAY) {
        throw new HttpException(
          `Your business has sent ${SUPPORT_REQUESTS_PER_DAY} requests today. Reply on an existing one, or email ${this.env.SUPPORT_NOTIFY_EMAIL}.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const created = await tx.supportRequest.create({
        data: {
          organizationId: context.organizationId,
          openedByUserId: context.userId,
          openedByEmail: email,
          kind: input.kind,
          subject: input.subject,
        },
      });

      await tx.supportMessage.create({
        data: {
          requestId: created.id,
          organizationId: context.organizationId,
          authorUserId: context.userId,
          authorEmail: email,
          fromStaff: false,
          body: input.body,
        },
      });

      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: context.organizationId },
        select: { name: true },
      });

      return { request: created, businessName: organization.name };
    });

    // Not awaited, and not the outbox: the request is safely stored and on
    // the staff console whatever the mail provider does.
    this.email
      .send({
        to: this.env.SUPPORT_NOTIFY_EMAIL,
        subject: `Help request from ${businessName}: ${input.subject}`.replace(/[\r\n]+/g, ' '),
        body: `${email} (${businessName}) sent a ${input.kind.toLowerCase()}:\n\n${input.body}`,
        link: `${this.env.APP_URL}/staff/help/${request.id}`,
      })
      .catch((error) =>
        this.logger.error(`Could not tell staff about help request ${request.id}`, error),
      );

    return toSupportSummary(request);
  }

  /** The business replies. Anything not waiting on us is waiting on us again. */
  async reply(
    context: TenantContext,
    permissions: PermissionSet,
    email: string,
    requestId: string,
    body: string,
  ): Promise<void> {
    await this.prisma.withTenant(context, async (tx) => {
      const request = await tx.supportRequest.findFirst({
        where: { AND: [{ id: requestId }, this.visibleTo(context, permissions)] },
        select: { id: true },
      });
      if (!request) throw new NotFoundException();

      await tx.supportMessage.create({
        data: {
          requestId,
          organizationId: context.organizationId,
          authorUserId: context.userId,
          authorEmail: email,
          fromStaff: false,
          body,
        },
      });

      await tx.supportRequest.update({
        where: { id: requestId },
        data: { status: 'OPEN', resolvedAt: null },
      });
    });
  }
}
