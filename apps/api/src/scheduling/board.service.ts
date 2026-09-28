import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, TenantContext, TransactionClient } from '@platform/db';
import {
  EVENT_TYPES,
  PERMISSIONS,
  wallTimeToInstant,
  type BoardJob,
  type BoardPerson,
  type BoardQuery,
  type BoardResponse,
  type HelpRequest,
  type JobHelpResponse,
} from '@platform/shared';
import { loadJobAccess } from '../common/job-access';
import { EventsService } from '../notifications/events.service';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

const nameOf = (
  person?: { firstName: string | null; lastName: string | null; email: string } | null,
) =>
  person ? [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email : null;

const HELP_INCLUDE = {
  job: { select: { title: true, locationId: true, location: { select: { name: true } } } },
} as const;
type HelpRow = Prisma.JobHelpRequestGetPayload<{ include: typeof HELP_INCLUDE }>;

const BOARD_JOB_INCLUDE = {
  location: { select: { name: true } },
  vehicle: { select: { name: true } },
  customer: { select: { displayName: true, locationId: true } },
  assignments: {
    select: {
      membershipId: true,
      member: { select: { user: { select: { firstName: true, lastName: true, email: true } } } },
    },
  },
} as const;
type BoardJobRow = Prisma.JobGetPayload<{ include: typeof BOARD_JOB_INCLUDE }>;

/** Today in a zone, as YYYY-MM-DD. */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * The manager's board and "Need a manager".
 *
 * The board is for whoever runs a branch: anyone who may book jobs there sees
 * that branch's day, an organization-wide admin every branch. It reads the
 * schedule; where someone is comes from the job they marked "On site".
 *
 * A call for a manager goes to the managers of the job's branch. A branch
 * with no manager of its own falls back to the owners and admins, so a call
 * is never lost. Only the crew on the job may call; only a manager of its
 * branch may acknowledge it; the caller or a manager may close it.
 */
@Injectable()
export class BoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  // -------------------------------------------------------------------------
  // The board
  // -------------------------------------------------------------------------

  async board(
    context: TenantContext,
    permissions: PermissionSet,
    query: BoardQuery,
  ): Promise<BoardResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const scope = permissions.locationsFor(PERMISSIONS.JOB_WRITE);
      const locations = await tx.location.findMany({
        where: { status: 'ACTIVE', ...(scope === null ? {} : { id: { in: [...scope] } }) },
        select: { id: true, name: true, timezone: true },
        orderBy: { name: 'asc' },
      });
      if (query.locationId && !locations.some((location) => location.id === query.locationId)) {
        throw new NotFoundException('That location does not exist');
      }
      const shown = query.locationId
        ? locations.filter((location) => location.id === query.locationId)
        : locations;

      const zone = shown[0]?.timezone ?? 'UTC';
      const day = query.day ?? todayIn(zone);
      const now = new Date();

      // The day in each branch's own zone, so a Tampa morning is a Tampa morning.
      const windows = shown.map((location) => ({
        locationId: location.id,
        from: wallTimeToInstant(day, 0, location.timezone),
        to: wallTimeToInstant(day, 24 * 60, location.timezone),
      }));
      const jobs =
        windows.length === 0
          ? []
          : await tx.job.findMany({
              where: {
                OR: windows.map((window) => ({
                  locationId: window.locationId,
                  startsAt: { lt: window.to },
                  endsAt: { gt: window.from },
                })),
                status: { notIn: ['CANCELLED'] },
              },
              include: BOARD_JOB_INCLUDE,
              orderBy: { startsAt: 'asc' },
            });

      const customerScope = permissions.locationsFor(PERMISSIONS.CUSTOMER_READ);
      const toJob = (row: BoardJobRow): BoardJob => {
        const customerVisible =
          row.customer === null ||
          customerScope === null ||
          (row.customer.locationId !== null && customerScope.has(row.customer.locationId));
        const late =
          (row.status === 'SCHEDULED' && row.startsAt < now) ||
          (row.status === 'IN_PROGRESS' && row.endsAt < now);
        return {
          id: row.id,
          title: row.title,
          status: row.status,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          customerName: customerVisible ? (row.customer?.displayName ?? null) : null,
          locationName: row.location?.name ?? null,
          vehicleName: row.vehicle?.name ?? null,
          crew: row.assignments.map((a) => nameOf(a.member.user) ?? 'Someone'),
          late,
        };
      };

      // Everyone working at these branches today, and everyone assigned there
      // by role even if nothing is booked, so a free pair of hands shows too.
      const people = new Map<string, { name: string; jobs: BoardJobRow[] }>();
      for (const job of jobs) {
        for (const assignment of job.assignments) {
          const entry = people.get(assignment.membershipId) ?? {
            name: nameOf(assignment.member.user) ?? 'Someone',
            jobs: [],
          };
          entry.jobs.push(job);
          people.set(assignment.membershipId, entry);
        }
      }
      const stationed = await tx.membershipRole.findMany({
        where: {
          scope: 'LOCATION',
          locations: { some: { locationId: { in: shown.map((location) => location.id) } } },
        },
        select: {
          membershipId: true,
          membership: {
            select: { user: { select: { firstName: true, lastName: true, email: true } } },
          },
        },
      });
      for (const entry of stationed) {
        if (!people.has(entry.membershipId)) {
          people.set(entry.membershipId, {
            name: nameOf(entry.membership.user) ?? 'Someone',
            jobs: [],
          });
        }
      }

      const board: BoardPerson[] = [...people.entries()].map(([membershipId, entry]) => {
        const current = [...entry.jobs].reverse().find((job) => job.status === 'IN_PROGRESS');
        const next = entry.jobs.find((job) => job.status === 'SCHEDULED');
        const doneCount = entry.jobs.filter((job) =>
          ['COMPLETED', 'NO_SHOW'].includes(job.status),
        ).length;
        return {
          membershipId,
          name: entry.name,
          state: current
            ? 'ON_SITE'
            : next
              ? 'BETWEEN_JOBS'
              : entry.jobs.length > 0
                ? 'DONE'
                : 'NOTHING_BOOKED',
          current: current ? toJob(current) : null,
          next: next ? toJob(next) : null,
          jobCount: entry.jobs.length,
          doneCount,
        };
      });
      const order = { ON_SITE: 0, BETWEEN_JOBS: 1, DONE: 2, NOTHING_BOOKED: 3 } as const;
      board.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));

      const help = await tx.jobHelpRequest.findMany({
        where: {
          status: { not: 'RESOLVED' },
          job: { locationId: { in: shown.map((location) => location.id) } },
        },
        include: HELP_INCLUDE,
        orderBy: { createdAt: 'asc' },
      });

      return {
        day,
        locations: locations.map((location) => ({ id: location.id, name: location.name })),
        locationId: query.locationId ?? null,
        people: board,
        unassigned: jobs.filter((job) => job.assignments.length === 0).map(toJob),
        late: jobs.map(toJob).filter((job) => job.late),
        help: help.map((row) => this.toHelp(row, permissions)),
        counts: {
          total: jobs.length,
          completed: jobs.filter((job) => job.status === 'COMPLETED').length,
          inProgress: jobs.filter((job) => job.status === 'IN_PROGRESS').length,
          remaining: jobs.filter((job) => job.status === 'SCHEDULED').length,
        },
      };
    });
  }

  // -------------------------------------------------------------------------
  // "Need a manager"
  // -------------------------------------------------------------------------

  async jobHelp(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    jobId: string,
  ): Promise<JobHelpResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const access = await loadJobAccess(tx, permissions, membershipId, jobId);
      const open = await tx.jobHelpRequest.findFirst({
        where: { jobId, status: { not: 'RESOLVED' } },
        include: HELP_INCLUDE,
      });
      const latest =
        open ??
        (await tx.jobHelpRequest.findFirst({
          where: { jobId },
          include: HELP_INCLUDE,
          orderBy: { createdAt: 'desc' },
        }));
      return {
        request: latest ? this.toHelp(latest, permissions) : null,
        canRequest: access.onCrew,
      };
    });
  }

  async requestHelp(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    jobId: string,
    note: string | undefined,
  ): Promise<HelpRequest> {
    return this.prisma.withTenant(context, async (tx) => {
      const access = await loadJobAccess(tx, permissions, membershipId, jobId);
      if (!access.onCrew) {
        throw new ForbiddenException('Only the crew on this job can call for a manager');
      }
      const open = await tx.jobHelpRequest.findFirst({
        where: { jobId, status: { not: 'RESOLVED' } },
        select: { id: true },
      });
      if (open) throw new ConflictException('A manager has already been called to this job');

      const name = await this.nameOfMember(tx, membershipId);
      const row = await tx.jobHelpRequest.create({
        data: {
          organizationId: context.organizationId,
          jobId,
          note: note?.trim() || null,
          requestedById: membershipId,
          requestedByName: name,
        },
        include: HELP_INCLUDE,
      });

      await this.events.emit(tx, context.organizationId, EVENT_TYPES.HELP_REQUESTED, {
        requestId: row.id,
        jobId,
        title: row.job.title,
        locationId: row.job.locationId ?? '',
        requesterMembershipId: membershipId,
        requesterName: name,
        note: row.note ?? '',
      });

      return this.toHelp(row, permissions);
    });
  }

  async acknowledge(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    requestId: string,
  ): Promise<HelpRequest> {
    return this.prisma.withTenant(context, async (tx) => {
      const row = await this.loadHelp(tx, permissions, membershipId, requestId);
      if (!this.canManage(permissions, row.job.locationId)) {
        throw new ForbiddenException('Only a manager of this branch can answer that');
      }
      if (row.status !== 'OPEN')
        throw new BadRequestException('That call has already been answered');

      const name = await this.nameOfMember(tx, membershipId);
      const updated = await tx.jobHelpRequest.update({
        where: { id: requestId },
        data: { status: 'ACKNOWLEDGED', acknowledgedByName: name, acknowledgedAt: new Date() },
        include: HELP_INCLUDE,
      });

      if (row.requestedById) {
        await this.events.emit(tx, context.organizationId, EVENT_TYPES.HELP_ACKNOWLEDGED, {
          requestId,
          jobId: row.jobId,
          title: row.job.title,
          membershipId: row.requestedById,
          managerName: name,
        });
      }
      return this.toHelp(updated, permissions);
    });
  }

  /** The caller, or a manager of the branch, closes it. */
  async resolve(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    requestId: string,
  ): Promise<HelpRequest> {
    return this.prisma.withTenant(context, async (tx) => {
      const row = await this.loadHelp(tx, permissions, membershipId, requestId);
      if (!this.canManage(permissions, row.job.locationId) && row.requestedById !== membershipId) {
        throw new ForbiddenException('Only the caller or a manager of this branch can close that');
      }
      if (row.status === 'RESOLVED') throw new BadRequestException('That call is already closed');

      const name = await this.nameOfMember(tx, membershipId);
      const updated = await tx.jobHelpRequest.update({
        where: { id: requestId },
        data: {
          status: 'RESOLVED',
          resolvedByName: name,
          resolvedAt: new Date(),
          // Closed without being acknowledged: record who closed it as having seen it.
          ...(row.acknowledgedAt ? {} : { acknowledgedByName: name, acknowledgedAt: new Date() }),
        },
        include: HELP_INCLUDE,
      });
      return this.toHelp(updated, permissions);
    });
  }

  // -------------------------------------------------------------------------

  private canManage(permissions: PermissionSet, locationId: string | null): boolean {
    return locationId === null
      ? permissions.has(PERMISSIONS.JOB_WRITE)
      : permissions.hasAt(PERMISSIONS.JOB_WRITE, locationId);
  }

  /** A call on a job the reader may see; 404 otherwise. */
  private async loadHelp(
    tx: TransactionClient,
    permissions: PermissionSet,
    membershipId: string,
    requestId: string,
  ): Promise<HelpRow> {
    const row = await tx.jobHelpRequest.findUnique({
      where: { id: requestId },
      include: HELP_INCLUDE,
    });
    if (!row) throw new NotFoundException('That call does not exist');
    try {
      await loadJobAccess(tx, permissions, membershipId, row.jobId);
    } catch {
      throw new NotFoundException('That call does not exist');
    }
    return row;
  }

  private async nameOfMember(tx: TransactionClient, membershipId: string): Promise<string> {
    const membership = await tx.organizationMembership.findUnique({
      where: { id: membershipId },
      select: { user: { select: { firstName: true, lastName: true, email: true } } },
    });
    return nameOf(membership?.user) ?? 'Someone';
  }

  private toHelp(row: HelpRow, permissions: PermissionSet): HelpRequest {
    return {
      id: row.id,
      jobId: row.jobId,
      jobTitle: row.job.title,
      locationName: row.job.location?.name ?? null,
      status: row.status,
      note: row.note,
      requestedByName: row.requestedByName,
      createdAt: row.createdAt.toISOString(),
      acknowledgedByName: row.acknowledgedByName,
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      resolvedByName: row.resolvedByName,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      canManage: this.canManage(permissions, row.job.locationId),
    };
  }
}
