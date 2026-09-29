import {
  PERFORMANCE_MEASURES,
  type PerformanceMeasure,
  type PerformanceMeasureKey,
  type PerformanceStat,
} from '@platform/shared';

/** Kept out of any 'use client' file so server components can read it too. */
export const measureOf = (key: PerformanceMeasureKey): PerformanceMeasure =>
  PERFORMANCE_MEASURES.find((measure) => measure.key === key)!;

/** The second line under a count: its context, never a verdict. */
export function detailLine(key: PerformanceMeasureKey, stat: PerformanceStat): string | null {
  const measure = measureOf(key);
  if (measure.detail === null || stat.detail === null) return null;
  if (measure.detailKind === 'outOf') {
    if (stat.detail === 0) return `none ${measure.detail}`;
    return `of ${stat.detail} ${measure.detail} · ${Math.round((stat.count / stat.detail) * 100)}%`;
  }
  if (stat.detail === 0 && measure.detailKind === 'part') return null;
  return `${stat.detail} ${measure.detail}`;
}

/** Periods offered, as whole days. Computed on the server's calendar; the API applies each branch's zone. */
export function periods(today = new Date()) {
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const weekStart = new Date(Date.UTC(y, m, today.getUTCDate() - ((today.getUTCDay() + 6) % 7)));
  const quarterStart = new Date(Date.UTC(y, m - (m % 3), 1));
  return [
    { key: 'week', label: 'This week', from: iso(weekStart), to: iso(today) },
    { key: 'month', label: 'This month', from: iso(new Date(Date.UTC(y, m, 1))), to: iso(today) },
    {
      key: 'last-month',
      label: 'Last month',
      from: iso(new Date(Date.UTC(y, m - 1, 1))),
      to: iso(new Date(Date.UTC(y, m, 0))),
    },
    { key: 'quarter', label: 'This quarter', from: iso(quarterStart), to: iso(today) },
  ] as const;
}

export const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
