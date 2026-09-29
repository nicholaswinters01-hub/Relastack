import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext, TransactionClient } from '@platform/db';
import {
  PERFORMANCE_MEASURES,
  PERMISSIONS,
  wallTimeToInstant,
  type MyPerformanceResponse,
  type PerformanceMeasureKey,
  type PerformancePerson,
  type PerformanceQuery,
  type PerformanceResponse,
  type PerformanceStandout,
  type PerformanceStat,
} from '@platform/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { PermissionSet } from '../rbac/permission-set';

type Stats = Partial<Record<PerformanceMeasureKey, PerformanceStat>>;

/** Several people tied for first all deserve the mention; past this it is no longer a standout. */
const MAX_STANDOUT_NAMES = 3;

const nameOf = (user: { firstName: string | null; lastName: string | null; email: string }) =>
  [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

function dayIn(timeZone: string, date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * How people are doing, measured from work the app already records.
 *
 * A manager sees the people of the branches they hold member.review at, and
 * only the work done at those branches: someone who also works elsewhere is
 * not measured there, because an aggregate is still a disclosure. Work counts
 * where it happened — a job at its branch, a task at its location, a lead or a
 * contract at its customer's home branch, a treatment at its job's branch. With
 * no location, work is counted only organization-wide, as it is everywhere.
 *
 * Everyone may see their own numbers, from all their work, and nobody else's.
 */
@Injectable()
export class PerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async team(
    context: TenantContext,
    permissions: PermissionSet,
    enabledModules: ReadonlySet<string>,
    query: PerformanceQuery,
  ): Promise<PerformanceResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const scope = permissions.locationsFor(PERMISSIONS.MEMBER_REVIEW);
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
      // Null means every location and none, which only an organization-wide view has.
      const locationIds = scope === null && !query.locationId ? null : shown.map((l) => l.id);

      const period = this.period(query, shown[0]?.timezone ?? 'UTC');
      const measures = this.measuresFor(enabledModules);
      const stats = await this.collect(tx, measures, period, locationIds, null);

      // The branch's people, whether or not they did any counted work, and
      // anyone else who did work there.
      const people = new Set(stats.keys());
      if (locationIds === null) {
        for (const member of await tx.organizationMembership.findMany({ select: { id: true } })) {
          people.add(member.id);
        }
      } else {
        const stationed = await tx.membershipRole.findMany({
          where: {
            scope: 'LOCATION',
            locations: { some: { locationId: { in: locationIds } } },
          },
          select: { membershipId: true },
        });
        for (const entry of stationed) people.add(entry.membershipId);
      }

      const members = await tx.organizationMembership.findMany({
        where: { id: { in: [...people] } },
        select: { id: true, user: { select: { firstName: true, lastName: true, email: true } } },
      });
      const rows: PerformancePerson[] = members
        .map((member) => ({
          membershipId: member.id,
          name: nameOf(member.user),
          stats: this.complete(measures, stats.get(member.id)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return {
        from: period.from,
        to: period.to,
        measures,
        scope: {
          organizationWide: locationIds === null,
          locations: shown.map((location) => ({ id: location.id, name: location.name })),
        },
        people: rows,
        standouts: this.standouts(measures, rows),
      };
    });
  }

  async mine(
    context: TenantContext,
    membershipId: string,
    enabledModules: ReadonlySet<string>,
    query: PerformanceQuery,
  ): Promise<MyPerformanceResponse> {
    return this.prisma.withTenant(context, async (tx) => {
      const home = await tx.location.findFirst({
        where: { status: 'ACTIVE' },
        select: { timezone: true },
        orderBy: { name: 'asc' },
      });
      const period = this.period(query, home?.timezone ?? 'UTC');
      const measures = this.measuresFor(enabledModules);
      const stats = await this.collect(tx, measures, period, null, membershipId);
      return {
        from: period.from,
        to: period.to,
        measures,
        stats: this.complete(measures, stats.get(membershipId)),
      };
    });
  }

  // -------------------------------------------------------------------------

  private measuresFor(enabledModules: ReadonlySet<string>): PerformanceMeasureKey[] {
    return PERFORMANCE_MEASURES.filter((measure) => enabledModules.has(measure.module)).map(
      (measure) => measure.key,
    );
  }

  /** This month so far unless asked otherwise, as whole days in the branch's zone. */
  private period(query: PerformanceQuery, timeZone: string) {
    const today = dayIn(timeZone);
    const to = query.to ?? today;
    const from = query.from ?? `${to.slice(0, 7)}-01`;
    return {
      from,
      to,
      start: wallTimeToInstant(from, 0, timeZone),
      end: wallTimeToInstant(to, 24 * 60, timeZone),
    };
  }

  /** Zero rather than absent, so an empty month reads as nothing done, not unknown. */
  private complete(measures: PerformanceMeasureKey[], stats: Stats | undefined) {
    const full: Stats = {};
    for (const key of measures) {
      const measure = PERFORMANCE_MEASURES.find((m) => m.key === key)!;
      full[key] = stats?.[key] ?? { count: 0, detail: measure.detail === null ? null : 0 };
    }
    return full;
  }

  private standouts(
    measures: PerformanceMeasureKey[],
    people: PerformancePerson[],
  ): PerformanceStandout[] {
    const standouts: PerformanceStandout[] = [];
    for (const measure of measures) {
      const best = Math.max(0, ...people.map((person) => person.stats[measure]?.count ?? 0));
      if (best === 0) continue;
      const names = people
        .filter((person) => person.stats[measure]?.count === best)
        .map((person) => person.name);
      if (names.length > MAX_STANDOUT_NAMES) continue;
      standouts.push({ measure, names, count: best });
    }
    return standouts;
  }

  /**
   * Each measure's numbers per person. `locationIds` null counts everywhere;
   * `membershipId` narrows to one person.
   */
  private async collect(
    tx: TransactionClient,
    measures: PerformanceMeasureKey[],
    period: { start: Date; end: Date },
    locationIds: string[] | null,
    membershipId: string | null,
  ): Promise<Map<string, Stats>> {
    const stats = new Map<string, Stats>();
    const bump = (id: string | null, key: PerformanceMeasureKey, count: number, detail: number) => {
      if (!id) return;
      const entry = stats.get(id) ?? {};
      const measure = PERFORMANCE_MEASURES.find((m) => m.key === key)!;
      const current = entry[key] ?? { count: 0, detail: measure.detail === null ? null : 0 };
      entry[key] = {
        count: current.count + count,
        detail: current.detail === null ? null : current.detail + detail,
      };
      stats.set(id, entry);
    };
    const at = locationIds === null ? {} : { locationId: { in: locationIds } };
    const within = { gte: period.start, lt: period.end };
    const who = <K extends string>(field: K) =>
      (membershipId === null ? { [field]: { not: null } } : { [field]: membershipId }) as Record<
        K,
        string | { not: null }
      >;

    if (measures.includes('jobs')) {
      const done = await tx.jobAssignment.findMany({
        where: {
          ...(membershipId === null ? {} : { membershipId }),
          job: { status: 'COMPLETED', completedAt: within, ...at },
        },
        select: { membershipId: true, job: { select: { completedAt: true, endsAt: true } } },
      });
      for (const row of done) {
        const ranOver = row.job.completedAt! > row.job.endsAt ? 1 : 0;
        bump(row.membershipId, 'jobs', 1, ranOver);
      }
    }

    if (measures.includes('contracts')) {
      // A withdrawn contract is usually a mistake put right by sending again,
      // so it counts neither way.
      const sent = await tx.contract.findMany({
        where: {
          ...who('sentById'),
          sentAt: within,
          status: { not: 'VOIDED' },
          ...(locationIds === null ? {} : { customer: at }),
        },
        select: { sentById: true, status: true },
      });
      for (const row of sent) bump(row.sentById, 'contracts', row.status === 'SIGNED' ? 1 : 0, 1);
    }

    if (measures.includes('leads')) {
      const won = await tx.customer.findMany({
        where: { ...who('ownerMembershipId'), convertedAt: within, ...at },
        select: { ownerMembershipId: true },
      });
      for (const row of won) bump(row.ownerMembershipId, 'leads', 1, 0);
      // Still open now, whatever the period: the pile each person is working.
      const open = await tx.customer.groupBy({
        by: ['ownerMembershipId'],
        where: { ...who('ownerMembershipId'), stage: 'LEAD', ...at },
        _count: { _all: true },
      });
      for (const row of open) bump(row.ownerMembershipId, 'leads', 0, row._count._all);
    }

    if (measures.includes('tasks')) {
      const done = await tx.task.findMany({
        where: { ...who('assigneeMembershipId'), status: 'DONE', completedAt: within, ...at },
        select: { assigneeMembershipId: true, completedAt: true, dueAt: true },
      });
      for (const row of done) {
        const late = row.dueAt !== null && row.completedAt! > row.dueAt ? 1 : 0;
        bump(row.assigneeMembershipId, 'tasks', 1, late);
      }
    }

    if (measures.includes('treatments')) {
      const recorded = await tx.stockMovement.findMany({
        where: {
          ...who('recordedById'),
          reason: 'USED',
          createdAt: within,
          voidsMovementId: null,
          voidedBy: { is: null },
          jobId: { not: null },
          ...(locationIds === null ? {} : { job: at }),
        },
        select: { recordedById: true },
      });
      for (const row of recorded) bump(row.recordedById, 'treatments', 1, 0);
    }

    return stats;
  }
}
