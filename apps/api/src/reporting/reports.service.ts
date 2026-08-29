import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, type TenantContext } from '@platform/db';
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  PERMISSIONS,
  type Dashboard,
  type DailyCount,
  type ReportRange,
} from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * The numbers on the dashboard.
 *
 * The single thing that matters in this file: every count runs through the
 * SAME visibility filter as the list endpoint it summarises. An aggregate is
 * still a disclosure — telling a branch employee the company has forty
 * customers leaks the size of a book they can see four of, and a count narrowed
 * by date and tag can end up describing one person.
 *
 * The filters are deliberately rebuilt here rather than imported from the
 * feature services, because those take a membership id and shape rows for
 * display. What is duplicated is the rule, and the e2e suite asserts the two
 * agree by comparing a count against the list that produced it.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private customerScope(permissions: PermissionSet): Prisma.CustomerWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.CUSTOMER_READ);

    if (allowed === null) return {};

    const ids = [...allowed];

    return {
      OR: [{ locationId: { in: ids } }, { sharedLocations: { some: { locationId: { in: ids } } } }],
    };
  }

  private taskScope(permissions: PermissionSet, membershipId: string): Prisma.TaskWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.TASK_READ);

    if (allowed === null) return {};

    return {
      OR: [{ locationId: { in: [...allowed] } }, { assigneeMembershipId: membershipId }],
    };
  }

  private jobScope(permissions: PermissionSet, membershipId: string): Prisma.JobWhereInput {
    const allowed = permissions.locationsFor(PERMISSIONS.JOB_READ);

    if (allowed === null) return {};

    return {
      OR: [{ locationId: { in: [...allowed] } }, { assignments: { some: { membershipId } } }],
    };
  }

  async dashboard(
    context: TenantContext,
    permissions: PermissionSet,
    membershipId: string,
    range: ReportRange,
  ): Promise<Dashboard> {
    // Reading a report needs the permission for the thing being reported on.
    // Someone who cannot see customers does not get a customer count.
    if (!permissions.hasAnywhere(PERMISSIONS.ORGANIZATION_READ)) {
      throw new ForbiddenException('You do not have permission to view reports');
    }

    const to = range.to ?? asDay(new Date());
    const from =
      range.from ?? asDay(new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * 86_400_000));

    const start = new Date(`${from}T00:00:00.000Z`);
    // Inclusive of the last day, so a range of one day covers that whole day.
    const end = new Date(`${to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);

    const inRange = { gte: start, lt: end };

    const customerWhere = this.customerScope(permissions);
    const taskWhere = this.taskScope(permissions, membershipId);
    const jobWhere = this.jobScope(permissions, membershipId);

    const canSeeCustomers = permissions.hasAnywhere(PERMISSIONS.CUSTOMER_READ);
    const canSeeTasks = permissions.hasAnywhere(PERMISSIONS.TASK_READ);
    const canSeeJobs = permissions.hasAnywhere(PERMISSIONS.JOB_READ);

    /**
     * Combine the visibility scope with a condition, keeping both.
     *
     * Generic so each call is checked against the right table's where-input —
     * a loose `Record<string, unknown>` here would let a typo'd column through
     * silently and quietly widen a count.
     */
    const and = <T>(scope: T, extra: T): { AND: T[] } => ({ AND: [scope, extra] });

    const data = await this.prisma.withTenant(context, async (tx) => {
      const [
        customersTotal,
        customerLeads,
        customersActive,
        customersConverted,
        customersAdded,
        tasksOpen,
        tasksOverdue,
        tasksMine,
        tasksCompleted,
        jobsAhead,
        jobsCompleted,
        jobsCancelled,
        jobsNoShow,
        jobsScheduledInRange,
        completedRows,
      ] = await Promise.all([
        canSeeCustomers
          ? tx.customer.count({ where: and(customerWhere, { stage: { not: 'ARCHIVED' } }) })
          : 0,
        canSeeCustomers ? tx.customer.count({ where: and(customerWhere, { stage: 'LEAD' }) }) : 0,
        canSeeCustomers ? tx.customer.count({ where: and(customerWhere, { stage: 'ACTIVE' }) }) : 0,
        canSeeCustomers
          ? tx.customer.count({ where: and(customerWhere, { convertedAt: inRange }) })
          : 0,
        canSeeCustomers
          ? tx.customer.count({ where: and(customerWhere, { createdAt: inRange }) })
          : 0,

        canSeeTasks
          ? tx.task.count({ where: and(taskWhere, { status: { in: OPEN_STATUSES } }) })
          : 0,
        canSeeTasks
          ? tx.task.count({
              where: and(taskWhere, {
                dueAt: { lt: new Date() },
                status: { notIn: CLOSED_STATUSES },
              }),
            })
          : 0,
        canSeeTasks
          ? tx.task.count({
              where: and(taskWhere, {
                assigneeMembershipId: membershipId,
                status: { in: OPEN_STATUSES },
              }),
            })
          : 0,
        canSeeTasks
          ? tx.task.count({ where: and(taskWhere, { status: 'DONE', updatedAt: inRange }) })
          : 0,

        canSeeJobs
          ? tx.job.count({
              where: and(jobWhere, { status: 'SCHEDULED', startsAt: { gte: new Date() } }),
            })
          : 0,
        canSeeJobs
          ? tx.job.count({ where: and(jobWhere, { status: 'COMPLETED', startsAt: inRange }) })
          : 0,
        canSeeJobs
          ? tx.job.count({ where: and(jobWhere, { status: 'CANCELLED', startsAt: inRange }) })
          : 0,
        canSeeJobs
          ? tx.job.count({ where: and(jobWhere, { status: 'NO_SHOW', startsAt: inRange }) })
          : 0,
        canSeeJobs ? tx.job.count({ where: and(jobWhere, { startsAt: inRange }) }) : 0,

        canSeeJobs
          ? tx.job.findMany({
              where: and(jobWhere, { status: 'COMPLETED', startsAt: inRange }),
              select: { startsAt: true },
            })
          : [],
      ]);

      return {
        customersTotal,
        customerLeads,
        customersActive,
        customersConverted,
        customersAdded,
        tasksOpen,
        tasksOverdue,
        tasksMine,
        tasksCompleted,
        jobsAhead,
        jobsCompleted,
        jobsCancelled,
        jobsNoShow,
        jobsScheduledInRange,
        completedRows,
      };
    });

    // The denominator is visits that were meant to happen — a job cancelled in
    // advance was never a chance to be stood up, so it is excluded.
    const attempted = data.jobsCompleted + data.jobsNoShow;

    const jobLocations = permissions.locationsFor(PERMISSIONS.JOB_READ);

    return {
      from,
      to,
      customers: {
        total: data.customersTotal,
        leads: data.customerLeads,
        active: data.customersActive,
        convertedInRange: data.customersConverted,
        addedInRange: data.customersAdded,
      },
      tasks: {
        open: data.tasksOpen,
        overdue: data.tasksOverdue,
        mine: data.tasksMine,
        completedInRange: data.tasksCompleted,
      },
      jobs: {
        scheduledAhead: data.jobsAhead,
        completedInRange: data.jobsCompleted,
        cancelledInRange: data.jobsCancelled,
        noShowInRange: data.jobsNoShow,
        // Null, not zero. A rate over no visits is unanswerable, and 0% would
        // read as "perfect" rather than "nothing happened".
        noShowRate: attempted === 0 ? null : Math.round((data.jobsNoShow / attempted) * 100),
        completedByDay: ReportsService.byDay(data.completedRows, from, to),
      },
      scope: {
        organizationWide: jobLocations === null,
        locationCount: jobLocations === null ? 0 : jobLocations.size,
      },
    };
  }

  /**
   * Buckets rows into one entry per day, including the empty ones.
   *
   * A chart that omits quiet days compresses the gaps and makes a fortnight of
   * nothing look like steady work.
   */
  static byDay(rows: Array<{ startsAt: Date }>, from: string, to: string): DailyCount[] {
    const counts = new Map<string, number>();

    for (const row of rows) {
      const day = asDay(row.startsAt);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }

    const days: DailyCount[] = [];
    const cursor = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);

    // Capped so a silly range cannot generate an unbounded array.
    while (cursor.getTime() <= end.getTime() && days.length < 400) {
      const day = asDay(cursor);
      days.push({ day, count: counts.get(day) ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return days;
  }
}
