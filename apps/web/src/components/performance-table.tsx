'use client';

import { useState } from 'react';
import type { PerformanceMeasureKey, PerformancePerson } from '@platform/shared';
import { detailLine, measureOf } from '@/lib/performance-labels';

/**
 * Everyone's numbers, sortable by any measure. Sorting is the manager's
 * choice; the page itself never lists anyone as worst.
 */
export function PerformanceTable({
  measures,
  people,
}: {
  measures: PerformanceMeasureKey[];
  people: PerformancePerson[];
}) {
  const [sortBy, setSortBy] = useState<PerformanceMeasureKey | 'name'>('name');

  const sorted = [...people].sort((a, b) =>
    sortBy === 'name'
      ? a.name.localeCompare(b.name)
      : (b.stats[sortBy]?.count ?? 0) - (a.stats[sortBy]?.count ?? 0) ||
        a.name.localeCompare(b.name),
  );

  const header = (key: PerformanceMeasureKey | 'name', label: string) => (
    <th key={key} scope="col" className="px-4 py-2 text-left font-medium">
      <button
        type="button"
        onClick={() => setSortBy(key)}
        aria-pressed={sortBy === key}
        className={`text-xs uppercase tracking-wider ${
          sortBy === key ? 'text-[var(--color-ink)] underline underline-offset-4' : ''
        }`}
      >
        {label}
      </button>
    </th>
  );

  return (
    <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
      <table className="w-full min-w-[36rem] text-sm">
        <thead className="border-b border-[var(--color-line)] text-[var(--color-muted)]">
          <tr>
            {header('name', 'Person')}
            {measures.map((key) => header(key, `${measureOf(key).label} ${measureOf(key).count}`))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-line)]">
          {sorted.map((person) => (
            <tr key={person.membershipId}>
              <th scope="row" className="px-4 py-3 text-left font-medium">
                {person.name}
              </th>
              {measures.map((key) => {
                const stat = person.stats[key];
                const detail = stat ? detailLine(key, stat) : null;
                return (
                  <td key={key} className="px-4 py-3 align-top">
                    <span className="text-base font-semibold tabular-nums">{stat?.count ?? 0}</span>
                    {detail && (
                      <span className="block text-xs text-[var(--color-muted)]">{detail}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
