import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type TenantContext, type TransactionClient } from '@platform/db';
import {
  CLOSED_JOB_STATUSES,
  LIVE_JOB_STATUSES,
  PERMISSIONS,
  type CreateJobRequest,
  type Job,
  type JobConflict,
  type JobQuery,
  type PermissionKey,
  type UpdateJobRequest,
  EVENT_TYPES,
  type CreateSignoffRequest,
  type JobSignoff,
} from '@platform/shared';
import { EventsService } from '../notifications/events.service';
import { loadJobAccess } from '../common/job-access';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

const NOT_FOUND = 'Job not found';

const JOB_INCLUDE = {
  location: { select: { name: true, timezone: true } },
  vehicle: { select: { name: true } },
  customer: { select: { displayName: true, locationId: true, accountNumber: true } },
  createdBy: { select: { user: { select: { firstName: true, lastName: true, email: true } } } },
  assignments: {
    include: {
      member: {
        select: { id: true, user: { select: { firstName: true, lastName: true, email: true } } },
      },
    },
  },
} as const;

type JobRow = Prisma.JobGetPayload<{ include: typeof JOB_INCLUDE }>;

const nameOf = (person?: { firstName: string | null; lastName: string | null; email: string }) =>
  person ? [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email : null;

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  /**
   * Which jobs the caller may see.
   *
   * The same three ways in as tasks — organization-wide, at a location they
   * work at, or booked onto it themselves. A crew member sent to another
   * branch for the day can see that day's work without being able to see the
   * branch's schedule.
   */
  private visibilityFilter(permissions: PermissionSet, membershipId: string): Prisma.JobWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.JOB_READ);

    if (allowed === null) return {};

    return {
      OR: [{ locationId: { in: [...allowed] } }, { assignments: { some: { membershipId } } }],
    };
  }

  private scopedTo(
    permissions: PermissionSet,
    membershipId: string,
    where: Prisma.JobWhereInput,
  ): Prisma.JobWhereInput {
    // AND, never a spread — the filter carries its own keys.
    return { AND: [where, this.visibilityFilter(permissions, membershipId)] };
  }

  private assertPermissionAnywhere(
    permissions: PermissionSet,
    permission: PermissionKey,
    action: string,
  ): void {
    if (!permissions.hasAnywhere(permission)) {
      throw new ForbiddenException(`You do not have permission to ${action}`);
    }
  }

  private assertCanWrite(permissions: PermissionSet, locationId: string | null): void {
    if (locationId === null) {
      if (!permissions.has(PERMISSIONS.JOB_WRITE)) {
        throw new ForbiddenException(
          'Only an organization-wide role can change a job that is not tied to a location',
        );
      }
      return;
    }

    if (!permissions.hasAt(PERMISSIONS.JOB_WRITE, locationId)) {
      throw new ForbiddenException('You do not have permission to change jobs here');
    }
  }

  // -------------------------------------------------------------------------
  // Shaping
  // -------------------------------------------------------------------------

  /**
   * The public shape, hiding the customer when the reader may not see them.
   *
   * Identical rule to tasks, and it matters more here: a crew member booked
   * onto a job at another branch can read the job, and without this they would
   * learn the name of a customer the CRM carefully hides from them.
   */
  static toPublic(row: JobRow, visibleCustomerLocations: ReadonlySet<string> | null): Job {
    const customerVisible =
      row.customer === null ||
      visibleCustomerLocations === null ||
      (row.customer.locationId !== null && visibleCustomerLocations.has(row.customer.locationId));

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      locationId: row.locationId,
      locationName: row.location?.name ?? null,
      // Sent so the browser renders the time as the crew reads it, rather than
      // in whatever zone the viewer's laptop happens to be set to.
      locationTimezone: row.location?.timezone ?? null,
      customerId: customerVisible ? row.customerId : null,
      customerName: customerVisible ? (row.customer?.displayName ?? null) : null,
      customerAccountNumber: customerVisible ? (row.customer?.accountNumber ?? null) : null,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      country: row.country,
      assignees: row.assignments.map((assignment) => ({
        membershipId: assignment.membershipId,
        name: nameOf(assignment.member.user) ?? 'Unknown',
      })),
      vehicleId: row.vehicleId,
      vehicleName: row.vehicle?.name ?? null,
      createdByName: nameOf(row.createdBy?.user),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private customerScope(permissions: PermissionSet): ReadonlySet<string> | null {
    return permissions.locationsFor(PERMISSIONS.CUSTOMER_READ);
  }

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------

  /**
   * Who among these people is already booked in an overlapping window.
   *
   * Half-open comparison: `starts < otherEnds AND ends > otherStarts`. A job
   * ending at 2pm does not clash with one starting at 2pm, because
   * back-to-back is how a day is actually filled and warning on it would train
   * people to ignore the warning.
   *
   * Cancelled and no-show jobs are excluded — the slot is free again. Completed
   * ones are NOT: they still happened, and a clash with one is a real
   * double-booking somebody should know about.
   */
  private async findConflicts(
    tx: TransactionClient,
    membershipIds: string[],
    startsAt: Date,
    endsAt: Date,
    excludeJobId?: string,
  ): Promise<JobConflict[]> {
    if (membershipIds.length === 0) return [];

    const clashes = await tx.jobAssignment.findMany({
      where: {
        membershipId: { in: membershipIds },
        job: {
          status: { notIn: ['CANCELLED', 'NO_SHOW'] },
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
          ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
        },
      },
      include: {
        job: { select: { id: true, title: true, startsAt: true, endsAt: true } },
        member: { select: { user: { select: { firstName: true, lastName: true, email: true } } } },
      },
    });

    return clashes.map((clash) => ({
      membershipId: clash.membershipId,
      name: nameOf(clash.member.user) ?? 'Unknown',
      jobId: clash.job.id,
      jobTitle: clash.job.title,
      startsAt: clash.job.startsAt.toISOString(),
      endsAt: clash.job.endsAt.toISOString(),
    }));
  }

  /**
   * Warn, do not block.
   *
   * Real businesses overlap on purpose — a ten-minute drop-in during a long
   * job, a crew splitting between two sites. Refusing outright gets worked
   * around by booking the job in the wrong slot, which is worse than the
   * overlap. So the first attempt returns 409 with the detail, and the caller
   * resubmits with acknowledgeConflicts once a person has looked at it.
   */
  private raiseIfUnacknowledged(conflicts: JobConflict[], acknowledged: boolean): void {
    if (conflicts.length === 0 || acknowledged) return;

    const names = [...new Set(conflicts.map((conflict) => conflict.name))];

    throw new ConflictException({
      statusCode: 409,
      code: 'SCHEDULE_CONFLICT',
      message: `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} already booked then.`,
      conflicts,
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    query: JobQuery,
  ): Promise<{ jobs: Job[]; nextCursor: string | null }> {
    this.assertPermissionAnywhere(permissions, PERMISSIONS.JOB_READ, 'view the schedule');

    const filters: Prisma.JobWhereInput[] = [];

    if (query.from) filters.push({ startsAt: { gte: new Date(query.from) } });
    if (query.to) filters.push({ startsAt: { lt: new Date(query.to) } });

    if (query.status) filters.push({ status: query.status });
    else if (query.liveOnly) filters.push({ status: { in: LIVE_JOB_STATUSES } });

    if (query.mine) filters.push({ assignments: { some: { membershipId } } });
    else if (query.assigneeMembershipId) {
      filters.push({ assignments: { some: { membershipId: query.assigneeMembershipId } } });
    }

    if (query.customerId) filters.push({ customerId: query.customerId });
    if (query.locationId) filters.push({ locationId: query.locationId });

    if (query.search) {
      filters.push({
        OR: [
          { title: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }

    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.job.findMany({
        where: this.scopedTo(permissions, membershipId, filters.length > 0 ? { AND: filters } : {}),
        include: JOB_INCLUDE,
        // Chronological: a calendar is read forwards.
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    );

    const page = rows.slice(0, query.limit);
    const scope = this.customerScope(permissions);

    return {
      jobs: page.map((row) => JobsService.toPublic(row, scope)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async getById(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    id: string,
  ): Promise<Job> {
    this.assertPermissionAnywhere(permissions, PERMISSIONS.JOB_READ, 'view the schedule');

    const row = await this.prisma.withTenant(context, (tx) =>
      tx.job.findFirst({
        where: this.scopedTo(permissions, membershipId, { id }),
        include: JOB_INCLUDE,
      }),
    );

    if (!row) throw new NotFoundException(NOT_FOUND);

    return JobsService.toPublic(row, this.customerScope(permissions));
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  async create(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    input: CreateJobRequest,
  ): Promise<Job> {
    const locationId = input.locationId ?? null;
    this.assertCanWrite(permissions, locationId);

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const assignees = [...new Set(input.assigneeMembershipIds ?? [])];

    const created = await this.prisma.withTenant(context, async (tx) => {
      await this.assertReferencesExist(tx, input.locationId, input.customerId, assignees);

      const conflicts = await this.findConflicts(tx, assignees, startsAt, endsAt);
      this.raiseIfUnacknowledged(conflicts, input.acknowledgeConflicts);

      const job = await tx.job.create({
        data: {
          organizationId: context.organizationId,
          title: input.title,
          description: input.description ?? null,
          status: input.status,
          startsAt,
          endsAt,
          completedAt: input.status === 'COMPLETED' ? new Date() : null,
          locationId,
          customerId: input.customerId ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          region: input.region ?? null,
          postalCode: input.postalCode ?? null,
          country: input.country ?? null,
          createdByMembershipId: membershipId,
        },
        select: { id: true },
      });

      for (const assignee of assignees) {
        await tx.jobAssignment.create({
          data: { jobId: job.id, membershipId: assignee, organizationId: context.organizationId },
        });
      }

      // Told about the work they were just given, in the same transaction
      // that gave it to them.
      const told = assignees.filter((id) => id !== membershipId);
      if (told.length > 0) {
        await this.events.emit(tx, context.organizationId, EVENT_TYPES.JOB_ASSIGNED, {
          jobId: job.id,
          title: input.title,
          membershipIds: told.join(','),
          when: startsAt.toISOString(),
          day: startsAt.toISOString().slice(0, 10),
        });
      }

      return job;
    });

    this.logger.log(`Job ${created.id} booked in organization ${context.organizationId}`);

    return this.getById(context, permissions, membershipId, created.id);
  }

  async update(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    id: string,
    input: UpdateJobRequest,
  ): Promise<Job> {
    await this.prisma.withTenant(context, async (tx) => {
      const current = await tx.job.findFirst({
        where: this.scopedTo(permissions, membershipId, { id }),
        select: {
          id: true,
          locationId: true,
          status: true,
          completedAt: true,
          startsAt: true,
          endsAt: true,
          assignments: { select: { membershipId: true } },
        },
      });

      if (!current) throw new NotFoundException(NOT_FOUND);

      /*
       * Whoever is ON the job may move its status, whatever their role.
       *
       * A crew that cannot mark a visit complete from the van is a crew that
       * stops using the software. Narrow, as with tasks: the status only. An
       * assignee without job.write cannot move the time, change the address,
       * or add somebody else to the crew.
       */
      const isAssignee = current.assignments.some(
        (assignment) => assignment.membershipId === membershipId,
      );

      /*
       * Count the fields being CHANGED, not the keys in the payload.
       *
       * `acknowledgeConflicts` carries a Zod default, so it is present on every
       * parsed body whether the caller sent it or not. Counting raw keys
       * therefore never reached one, and the crew could never complete their
       * own job — the rule was dead on arrival, and only a test caught it.
       *
       * Listing control fields explicitly means the next flag added here has to
       * be considered rather than silently breaking the rule again.
       */
      const CONTROL_FIELDS = new Set(['acknowledgeConflicts']);
      const changed = Object.keys(input).filter((key) => !CONTROL_FIELDS.has(key));
      const statusOnly = changed.length === 1 && changed[0] === 'status';

      if (!(isAssignee && statusOnly)) {
        this.assertCanWrite(permissions, current.locationId);
      }

      if (input.locationId !== undefined && input.locationId !== current.locationId) {
        // Authority at both ends, so a job cannot be pushed to a branch the
        // mover has no reach into.
        this.assertCanWrite(permissions, input.locationId ?? null);
      }

      const assignees =
        input.assigneeMembershipIds === undefined
          ? current.assignments.map((assignment) => assignment.membershipId)
          : [...new Set(input.assigneeMembershipIds)];

      await this.assertReferencesExist(tx, input.locationId, input.customerId, assignees);

      const startsAt = input.startsAt ? new Date(input.startsAt) : current.startsAt;
      const endsAt = input.endsAt ? new Date(input.endsAt) : current.endsAt;

      if (endsAt <= startsAt) {
        throw new BadRequestException('The job has to end after it starts');
      }

      // Re-check only when the window or the crew actually moved. Marking a
      // job complete should not warn about a clash nobody introduced.
      const windowMoved =
        startsAt.getTime() !== current.startsAt.getTime() ||
        endsAt.getTime() !== current.endsAt.getTime();
      const crewChanged = input.assigneeMembershipIds !== undefined;

      if (windowMoved || crewChanged) {
        const conflicts = await this.findConflicts(tx, assignees, startsAt, endsAt, id);
        this.raiseIfUnacknowledged(conflicts, input.acknowledgeConflicts);
      }

      const becomingComplete = input.status === 'COMPLETED' && current.status !== 'COMPLETED';

      /*
       * Editing one visit takes it out of the series' reach for good.
       *
       * Somebody moved this Tuesday to Thursday on purpose. Dragging it back
       * the next time the rule changes is how people stop trusting a calendar,
       * so the visit is marked detached and regeneration leaves it alone
       * afterwards.
       *
       * A status change alone does not detach: marking a visit complete is
       * doing the work, not overriding the schedule.
       */
      const SCHEDULE_NEUTRAL = new Set(['acknowledgeConflicts', 'status']);
      const overridesSchedule = Object.keys(input).some((key) => !SCHEDULE_NEUTRAL.has(key));

      await tx.job.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.startsAt !== undefined ? { startsAt } : {}),
          ...(input.endsAt !== undefined ? { endsAt } : {}),
          ...(input.locationId !== undefined ? { locationId: input.locationId ?? null } : {}),
          ...(input.customerId !== undefined ? { customerId: input.customerId ?? null } : {}),
          ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 ?? null } : {}),
          ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 ?? null } : {}),
          ...(input.city !== undefined ? { city: input.city ?? null } : {}),
          ...(input.region !== undefined ? { region: input.region ?? null } : {}),
          ...(input.postalCode !== undefined ? { postalCode: input.postalCode ?? null } : {}),
          ...(input.country !== undefined ? { country: input.country ?? null } : {}),
          // Stamped on the first completion only.
          ...(becomingComplete && current.completedAt === null ? { completedAt: new Date() } : {}),
          ...(overridesSchedule ? { detachedFromSeries: true } : {}),
        },
      });

      /*
       * The crew hears when the plan changes under them.
       *
       * Only a move or a cancellation — not every edit. Retitling a job or
       * correcting its postcode is not something to interrupt somebody's day
       * for, and a notification that fires on everything is one people mute.
       */
      const cancelled = input.status === 'CANCELLED' && current.status !== 'CANCELLED';
      const crewToTell = assignees.filter((id) => id !== membershipId);

      if (crewToTell.length > 0 && (windowMoved || cancelled)) {
        await this.events.emit(
          tx,
          context.organizationId,
          cancelled ? EVENT_TYPES.JOB_CANCELLED : EVENT_TYPES.JOB_CHANGED,
          {
            jobId: id,
            title: input.title ?? '',
            membershipIds: crewToTell.join(','),
            when: startsAt.toISOString(),
            day: startsAt.toISOString().slice(0, 10),
          },
        );
      }

      if (crewChanged) {
        await tx.jobAssignment.deleteMany({
          where: { jobId: id, membershipId: { notIn: assignees } },
        });

        for (const assignee of assignees) {
          // Upsert rather than create-and-catch: a unique violation aborts the
          // whole transaction in PostgreSQL.
          await tx.jobAssignment.upsert({
            where: { jobId_membershipId: { jobId: id, membershipId: assignee } },
            create: { jobId: id, membershipId: assignee, organizationId: context.organizationId },
            update: {},
          });
        }
      }
    });

    return this.getById(context, permissions, membershipId, id);
  }

  /**
   * Permanent removal. Needs job.delete, which only an owner holds.
   *
   * Cancelling records that the visit did not happen, which is a number the
   * business needs. Deleting destroys the fact it was ever booked.
   */
  async remove(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    id: string,
  ): Promise<void> {
    if (!permissions.has(PERMISSIONS.JOB_DELETE)) {
      throw new ForbiddenException('You do not have permission to delete jobs');
    }

    const deleted = await this.prisma.withTenant(context, async (tx) => {
      // Materials used on it may be a pest application record, and a signed
      // visit is the customer's word: both are kept, so the job is too.
      const [materials, signoffs] = await Promise.all([
        tx.stockMovement.count({ where: { jobId: id } }),
        tx.jobSignoff.count({ where: { jobId: id } }),
      ]);
      if (materials > 0 || signoffs > 0) {
        const visible = await tx.job.count({
          where: this.scopedTo(permissions, membershipId, { id }),
        });
        if (visible === 0) throw new NotFoundException(NOT_FOUND);
        throw new ConflictException({
          statusCode: 409,
          code: 'JOB_HAS_RECORDS',
          message:
            'This job has materials or a customer signature recorded on it, which must be kept. Cancel it instead.',
        });
      }

      return tx.job.deleteMany({ where: this.scopedTo(permissions, membershipId, { id }) });
    });

    if (deleted.count === 0) throw new NotFoundException(NOT_FOUND);

    this.logger.warn(`Job ${id} permanently deleted from ${context.organizationId}`);
  }

  // -------------------------------------------------------------------------
  // Customer sign-off
  // -------------------------------------------------------------------------

  async signoff(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    jobId: string,
  ): Promise<JobSignoff | null> {
    return this.prisma.withTenant(context, async (tx) => {
      await loadJobAccess(tx, permissions, membershipId, jobId);
      const row = await tx.jobSignoff.findFirst({
        where: { jobId },
        orderBy: [{ signedAt: 'desc' }, { id: 'desc' }],
      });
      return row ? JobsService.toSignoff(row) : null;
    });
  }

  /**
   * The customer signs on the tech's phone. Never edited: signing again adds
   * another, and the latest is the one shown.
   */
  async createSignoff(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    jobId: string,
    input: CreateSignoffRequest,
  ): Promise<JobSignoff> {
    return this.prisma.withTenant(context, async (tx) => {
      const access = await loadJobAccess(tx, permissions, membershipId, jobId);
      if (!access.canRecordWork) {
        throw new ForbiddenException(
          'Only the crew on this job, or a manager, can take a signature',
        );
      }

      const recorder = await tx.organizationMembership.findUnique({
        where: { id: membershipId },
        select: { user: { select: { firstName: true, lastName: true, email: true } } },
      });
      const row = await tx.jobSignoff.create({
        data: {
          organizationId: context.organizationId,
          jobId,
          signerName: input.signerName,
          image: input.image,
          recordedById: membershipId,
          recordedByName: nameOf(recorder?.user) ?? 'Someone',
        },
      });
      return JobsService.toSignoff(row);
    });
  }

  private static toSignoff(row: {
    id: string;
    signerName: string;
    image: string;
    signedAt: Date;
    recordedByName: string;
  }): JobSignoff {
    return {
      id: row.id,
      signerName: row.signerName,
      image: row.image,
      signedAt: row.signedAt.toISOString(),
      recordedByName: row.recordedByName,
    };
  }

  // -------------------------------------------------------------------------

  private async assertReferencesExist(
    tx: TransactionClient,
    locationId?: string | null,
    customerId?: string | null,
    assigneeMembershipIds: string[] = [],
  ): Promise<void> {
    if (locationId) {
      if ((await tx.location.count({ where: { id: locationId } })) === 0) {
        throw new BadRequestException('That location does not exist');
      }
    }

    if (customerId) {
      if ((await tx.customer.count({ where: { id: customerId } })) === 0) {
        throw new BadRequestException('That customer does not exist');
      }
    }

    if (assigneeMembershipIds.length > 0) {
      const found = await tx.organizationMembership.count({
        where: { id: { in: assigneeMembershipIds } },
      });

      if (found !== assigneeMembershipIds.length) {
        throw new BadRequestException('One of those people is not in this organization');
      }
    }
  }

  /** Used by the closed-status list so the shared constant stays the source. */
  static isClosed(status: Job['status']): boolean {
    return CLOSED_JOB_STATUSES.includes(status);
  }
}
