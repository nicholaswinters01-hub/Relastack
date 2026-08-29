import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type TenantContext, type TransactionClient } from '@platform/db';
import {
  MATERIALISE_DAYS,
  PERMISSIONS,
  describeRecurrence,
  occurrencesBetween,
  wallTimeToInstant,
  type CreateJobSeriesRequest,
  type JobSeries,
  type RecurrenceRule,
  type UpdateJobSeriesRequest,
} from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

const NOT_FOUND = 'Series not found';

const SERIES_INCLUDE = {
  location: { select: { name: true, timezone: true } },
  customer: { select: { displayName: true, locationId: true } },
  assignments: {
    include: {
      member: { select: { user: { select: { firstName: true, lastName: true, email: true } } } },
    },
  },
  _count: { select: { jobs: true } },
} as const;

type SeriesRow = Prisma.JobSeriesGetPayload<{ include: typeof SERIES_INCLUDE }>;

const nameOf = (person?: { firstName: string | null; lastName: string | null; email: string }) =>
  person ? [person.firstName, person.lastName].filter(Boolean).join(' ') || person.email : null;

const asDay = (value: Date): string => value.toISOString().slice(0, 10);
const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);

  return asDay(date);
};

@Injectable()
export class JobSeriesService {
  private readonly logger = new Logger(JobSeriesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------

  private visibilityFilter(permissions: PermissionSet): Prisma.JobSeriesWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.JOB_READ);

    // No assignee clause here, unlike jobs. A series is a management object —
    // being on next Tuesday's visit does not mean seeing the contract behind
    // it. The visit itself remains visible through the job rules.
    return allowed === null ? {} : { locationId: { in: [...allowed] } };
  }

  private scopedTo(
    permissions: PermissionSet,
    where: Prisma.JobSeriesWhereInput,
  ): Prisma.JobSeriesWhereInput {
    return { AND: [where, this.visibilityFilter(permissions)] };
  }

  private assertCanWrite(permissions: PermissionSet, locationId: string | null): void {
    if (locationId === null) {
      if (!permissions.has(PERMISSIONS.JOB_WRITE)) {
        throw new ForbiddenException(
          'Only an organization-wide role can change a series that is not tied to a location',
        );
      }
      return;
    }

    if (!permissions.hasAt(PERMISSIONS.JOB_WRITE, locationId)) {
      throw new ForbiddenException('You do not have permission to change the schedule here');
    }
  }

  static ruleOf(row: {
    frequency: SeriesRow['frequency'];
    interval: number;
    byWeekday: number[];
    startsOn: Date;
    until: Date | null;
  }): RecurrenceRule {
    return {
      frequency: row.frequency,
      interval: row.interval,
      byWeekday: row.byWeekday,
      startsOn: asDay(row.startsOn),
      until: row.until ? asDay(row.until) : null,
    };
  }

  static toPublic(row: SeriesRow, visibleCustomerLocations: ReadonlySet<string> | null): JobSeries {
    const customerVisible =
      row.customer === null ||
      visibleCustomerLocations === null ||
      (row.customer.locationId !== null && visibleCustomerLocations.has(row.customer.locationId));

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      frequency: row.frequency,
      interval: row.interval,
      byWeekday: row.byWeekday,
      startsOn: asDay(row.startsOn),
      until: row.until ? asDay(row.until) : null,
      summary: describeRecurrence(JobSeriesService.ruleOf(row)),
      startMinutes: row.startMinutes,
      durationMinutes: row.durationMinutes,
      active: row.active,
      locationId: row.locationId,
      locationName: row.location?.name ?? null,
      locationTimezone: row.location?.timezone ?? null,
      customerId: customerVisible ? row.customerId : null,
      customerName: customerVisible ? (row.customer?.displayName ?? null) : null,
      addressLine1: row.addressLine1,
      city: row.city,
      assignees: row.assignments.map((assignment) => ({
        membershipId: assignment.membershipId,
        name: nameOf(assignment.member.user) ?? 'Unknown',
      })),
      bookedCount: row._count.jobs,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Materialisation
  // -------------------------------------------------------------------------

  /**
   * Book the visits this series should produce up to the horizon.
   *
   * Idempotent: a unique index on (series, occurrence day) means running it
   * twice books nothing twice, which matters because it runs on every edit and
   * a duplicated recurring job is the failure customers notice fastest.
   *
   * Only ever books FORWARD from today. Regenerating history would resurrect
   * visits somebody cancelled months ago.
   */
  private async materialise(
    tx: TransactionClient,
    organizationId: string,
    seriesId: string,
  ): Promise<number> {
    const series = await tx.jobSeries.findUniqueOrThrow({
      where: { id: seriesId },
      include: { location: { select: { timezone: true } }, assignments: true },
    });

    if (!series.active) return 0;

    const today = asDay(new Date());
    const from = asDay(series.startsOn) > today ? asDay(series.startsOn) : today;
    const horizon = addDays(today, MATERIALISE_DAYS);

    if (from > horizon) return 0;

    const days = occurrencesBetween(JobSeriesService.ruleOf(series), from, horizon);
    if (days.length === 0) return 0;

    // One query rather than one per day.
    const existing = await tx.job.findMany({
      where: {
        seriesId,
        seriesOccurrenceOn: { in: days.map((day) => new Date(`${day}T00:00:00Z`)) },
      },
      select: { seriesOccurrenceOn: true },
    });

    const already = new Set(
      existing.map((job) => (job.seriesOccurrenceOn ? asDay(job.seriesOccurrenceOn) : '')),
    );

    // A series with no branch has no zone of its own, so it falls back to UTC.
    // The alternative — the server's zone — would make the same series produce
    // different times depending on where it was deployed.
    const timeZone = series.location?.timezone ?? 'UTC';

    let booked = 0;

    for (const day of days) {
      if (already.has(day)) continue;

      const startsAt = wallTimeToInstant(day, series.startMinutes, timeZone);
      const endsAt = new Date(startsAt.getTime() + series.durationMinutes * 60_000);

      const job = await tx.job.create({
        data: {
          organizationId,
          title: series.title,
          description: series.description,
          startsAt,
          endsAt,
          locationId: series.locationId,
          customerId: series.customerId,
          addressLine1: series.addressLine1,
          addressLine2: series.addressLine2,
          city: series.city,
          region: series.region,
          postalCode: series.postalCode,
          country: series.country,
          createdByMembershipId: series.createdByMembershipId,
          seriesId,
          seriesOccurrenceOn: new Date(`${day}T00:00:00Z`),
        },
        select: { id: true },
      });

      for (const assignment of series.assignments) {
        await tx.jobAssignment.create({
          data: { jobId: job.id, membershipId: assignment.membershipId, organizationId },
        });
      }

      booked += 1;
    }

    return booked;
  }

  /**
   * Drop future visits that the rule no longer produces.
   *
   * Three things are deliberately left alone: anything in the past, anything
   * somebody has touched individually, and anything already started or
   * finished. A rule change should not quietly erase a visit a crew has
   * already been to, nor one an office manager moved to Thursday on purpose.
   */
  private async releaseStale(tx: TransactionClient, seriesId: string): Promise<number> {
    const series = await tx.jobSeries.findUniqueOrThrow({ where: { id: seriesId } });

    const today = new Date(`${asDay(new Date())}T00:00:00Z`);

    const future = await tx.job.findMany({
      where: {
        seriesId,
        detachedFromSeries: false,
        status: 'SCHEDULED',
        seriesOccurrenceOn: { gte: today },
      },
      select: { id: true, seriesOccurrenceOn: true },
    });

    if (future.length === 0) return 0;

    const rule = JobSeriesService.ruleOf(series);
    const keep = new Set(
      series.active
        ? occurrencesBetween(rule, asDay(today), addDays(asDay(today), MATERIALISE_DAYS + 365))
        : [],
    );

    const doomed = future
      .filter((job) => !keep.has(job.seriesOccurrenceOn ? asDay(job.seriesOccurrenceOn) : ''))
      .map((job) => job.id);

    if (doomed.length === 0) return 0;

    await tx.job.deleteMany({ where: { id: { in: doomed } } });

    return doomed.length;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(context: TenantContext, permissions: PermissionSet): Promise<JobSeries[]> {
    if (!permissions.hasAnywhere(PERMISSIONS.JOB_READ)) {
      throw new ForbiddenException('You do not have permission to view the schedule');
    }

    const rows = await this.prisma.withTenant(context, (tx) =>
      tx.jobSeries.findMany({
        where: this.scopedTo(permissions, {}),
        include: SERIES_INCLUDE,
        orderBy: [{ active: 'desc' }, { title: 'asc' }],
      }),
    );

    const scope = permissions.locationsFor(PERMISSIONS.CUSTOMER_READ);

    return rows.map((row) => JobSeriesService.toPublic(row, scope));
  }

  async getById(
    context: TenantContext,
    permissions: PermissionSet,
    id: string,
  ): Promise<JobSeries> {
    const row = await this.prisma.withTenant(context, (tx) =>
      tx.jobSeries.findFirst({
        where: this.scopedTo(permissions, { id }),
        include: SERIES_INCLUDE,
      }),
    );

    if (!row) throw new NotFoundException(NOT_FOUND);

    return JobSeriesService.toPublic(row, permissions.locationsFor(PERMISSIONS.CUSTOMER_READ));
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  async create(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    input: CreateJobSeriesRequest,
  ): Promise<{ series: JobSeries; booked: number }> {
    const locationId = input.locationId ?? null;
    this.assertCanWrite(permissions, locationId);

    const { id, booked } = await this.prisma.withTenant(context, async (tx) => {
      await this.assertReferencesExist(
        tx,
        locationId,
        input.customerId,
        input.assigneeMembershipIds,
      );

      const series = await tx.jobSeries.create({
        data: {
          organizationId: context.organizationId,
          title: input.title,
          description: input.description ?? null,
          frequency: input.frequency,
          interval: input.interval,
          byWeekday: input.byWeekday,
          startsOn: new Date(`${input.startsOn}T00:00:00Z`),
          until: input.until ? new Date(`${input.until}T00:00:00Z`) : null,
          startMinutes: input.startMinutes,
          durationMinutes: input.durationMinutes,
          locationId,
          customerId: input.customerId ?? null,
          addressLine1: input.addressLine1 || null,
          addressLine2: input.addressLine2 || null,
          city: input.city || null,
          region: input.region || null,
          postalCode: input.postalCode || null,
          country: input.country || null,
          createdByMembershipId: membershipId,
        },
        select: { id: true },
      });

      for (const assignee of new Set(input.assigneeMembershipIds)) {
        await tx.jobSeriesAssignment.create({
          data: {
            seriesId: series.id,
            membershipId: assignee,
            organizationId: context.organizationId,
          },
        });
      }

      return {
        id: series.id,
        booked: await this.materialise(tx, context.organizationId, series.id),
      };
    });

    this.logger.log(`Series ${id} created, ${booked} visits booked`);

    return { series: await this.getById(context, permissions, id), booked };
  }

  /**
   * Change the rule, and reconcile the visits it has already produced.
   *
   * This is "edit all future". Editing one visit is editing that job, which
   * detaches it and takes it out of reach of this entirely.
   */
  async update(
    context: TenantContext,
    permissions: PermissionSet,
    id: string,
    input: UpdateJobSeriesRequest,
  ): Promise<{ series: JobSeries; booked: number; released: number }> {
    const result = await this.prisma.withTenant(context, async (tx) => {
      const current = await tx.jobSeries.findFirst({
        where: this.scopedTo(permissions, { id }),
        select: { id: true, locationId: true },
      });

      if (!current) throw new NotFoundException(NOT_FOUND);

      this.assertCanWrite(permissions, current.locationId);

      if (input.locationId !== undefined && input.locationId !== current.locationId) {
        this.assertCanWrite(permissions, input.locationId ?? null);
      }

      await this.assertReferencesExist(
        tx,
        input.locationId,
        input.customerId,
        input.assigneeMembershipIds,
      );

      await tx.jobSeries.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
          ...(input.interval !== undefined ? { interval: input.interval } : {}),
          ...(input.byWeekday !== undefined ? { byWeekday: input.byWeekday } : {}),
          ...(input.startsOn !== undefined
            ? { startsOn: new Date(`${input.startsOn}T00:00:00Z`) }
            : {}),
          ...(input.until !== undefined
            ? { until: input.until ? new Date(`${input.until}T00:00:00Z`) : null }
            : {}),
          ...(input.startMinutes !== undefined ? { startMinutes: input.startMinutes } : {}),
          ...(input.durationMinutes !== undefined
            ? { durationMinutes: input.durationMinutes }
            : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.locationId !== undefined ? { locationId: input.locationId ?? null } : {}),
          ...(input.customerId !== undefined ? { customerId: input.customerId ?? null } : {}),
          ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 || null } : {}),
          ...(input.city !== undefined ? { city: input.city || null } : {}),
        },
      });

      if (input.assigneeMembershipIds !== undefined) {
        const wanted = [...new Set(input.assigneeMembershipIds)];

        await tx.jobSeriesAssignment.deleteMany({
          where: { seriesId: id, membershipId: { notIn: wanted } },
        });

        for (const assignee of wanted) {
          await tx.jobSeriesAssignment.upsert({
            where: { seriesId_membershipId: { seriesId: id, membershipId: assignee } },
            create: {
              seriesId: id,
              membershipId: assignee,
              organizationId: context.organizationId,
            },
            update: {},
          });
        }
      }

      // Release first, then rebook: a rule that moved Tuesday to Wednesday
      // must drop the Tuesdays before it can create the Wednesdays, or the
      // customer briefly has both.
      const released = await this.releaseStale(tx, id);
      const booked = await this.materialise(tx, context.organizationId, id);

      return { booked, released };
    });

    this.logger.log(`Series ${id} updated: ${result.booked} booked, ${result.released} released`);

    return { series: await this.getById(context, permissions, id), ...result };
  }

  /**
   * Stop a series without erasing its history.
   *
   * Future untouched visits are released; everything already done, started, or
   * individually moved stays exactly where it is. A customer cancelling in
   * March does not un-happen February.
   */
  async stop(
    context: TenantContext,
    permissions: PermissionSet,
    id: string,
  ): Promise<{ series: JobSeries; released: number }> {
    const released = await this.prisma.withTenant(context, async (tx) => {
      const current = await tx.jobSeries.findFirst({
        where: this.scopedTo(permissions, { id }),
        select: { id: true, locationId: true },
      });

      if (!current) throw new NotFoundException(NOT_FOUND);

      this.assertCanWrite(permissions, current.locationId);

      await tx.jobSeries.update({ where: { id }, data: { active: false } });

      return this.releaseStale(tx, id);
    });

    return { series: await this.getById(context, permissions, id), released };
  }

  /**
   * Top up the horizon for every live series.
   *
   * Called when the schedule is read past what has been booked. Phase 11's
   * scheduled jobs will do this on a timer instead; until then it happens
   * lazily, which is enough because nobody looks at a day that has not been
   * booked without asking for it first.
   */
  async topUp(context: TenantContext): Promise<number> {
    return this.prisma.withTenant(context, async (tx) => {
      const live = await tx.jobSeries.findMany({ where: { active: true }, select: { id: true } });

      let booked = 0;
      for (const series of live) {
        booked += await this.materialise(tx, context.organizationId, series.id);
      }

      return booked;
    });
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
        where: { id: { in: [...new Set(assigneeMembershipIds)] } },
      });

      if (found !== new Set(assigneeMembershipIds).size) {
        throw new BadRequestException('One of those people is not in this organization');
      }
    }
  }
}
