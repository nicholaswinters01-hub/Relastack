import Link from 'next/link';
import type { Dashboard } from '@platform/shared';

/**
 * The numbers, and where each one leads.
 *
 * Every figure links to the list it summarises. A dashboard whose numbers are
 * dead ends makes people go and find the same thing again by hand, which is
 * how dashboards end up unread.
 *
 * Nothing here decides what is counted — the server already narrowed every
 * figure to what this reader may see, and says so in `scope`.
 */
export function DashboardView({ dashboard }: { dashboard: Dashboard }) {
  const { customers, tasks, jobs, scope } = dashboard;

  const busiest = Math.max(1, ...jobs.completedByDay.map((day) => day.count));

  return (
    <div className="mt-8 flex flex-col gap-8">
      {!scope.organizationWide && (
        <p className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-muted)]">
          These figures cover the {scope.locationCount}{' '}
          {scope.locationCount === 1 ? 'location' : 'locations'} you work at, not the whole company.
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Needs attention
        </h2>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Stat
            label="Overdue tasks"
            value={tasks.overdue}
            href="/tasks?filter=overdue"
            tone={tasks.overdue > 0 ? 'bad' : 'quiet'}
          />
          <Stat label="Assigned to you" value={tasks.mine} href="/tasks?filter=mine" />
          <Stat label="Jobs booked ahead" value={jobs.scheduledAhead} href="/schedule" />
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Customers
        </h2>

        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <Stat label="Total" value={customers.total} href="/customers" />
          <Stat label="Leads" value={customers.leads} href="/customers?stage=LEAD" />
          <Stat label="Active" value={customers.active} href="/customers?stage=ACTIVE" />
          <Stat label="Won this period" value={customers.convertedInRange} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Work in this period
        </h2>

        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <Stat label="Jobs completed" value={jobs.completedInRange} />
          <Stat label="Tasks completed" value={tasks.completedInRange} />
          <Stat label="Cancelled" value={jobs.cancelledInRange} />
          <Stat
            label="No-shows"
            // Null means nothing was scheduled. A rate over no visits is
            // unanswerable, and "0%" would read as perfect rather than empty.
            value={jobs.noShowRate === null ? '—' : `${jobs.noShowRate}%`}
            tone={jobs.noShowRate !== null && jobs.noShowRate > 10 ? 'bad' : 'quiet'}
          />
        </div>

        {jobs.completedByDay.length > 1 && (
          <div className="mt-5 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            <p className="text-xs text-[var(--color-muted)]">Jobs completed each day</p>

            <div
              className="mt-3 flex h-24 items-end gap-px"
              role="img"
              aria-label="Jobs completed each day"
            >
              {jobs.completedByDay.map((day) => (
                <div
                  key={day.day}
                  title={`${day.day}: ${day.count}`}
                  style={{ height: `${Math.max(2, (day.count / busiest) * 100)}%` }}
                  className={`flex-1 rounded-sm ${
                    day.count > 0 ? 'bg-[var(--color-ink)]' : 'bg-[var(--color-line)]'
                  }`}
                />
              ))}
            </div>

            <p className="mt-2 flex justify-between font-mono text-xs text-[var(--color-muted)]">
              <span>{dashboard.from}</span>
              <span>{dashboard.to}</span>
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  tone = 'quiet',
}: {
  label: string;
  value: number | string;
  href?: string;
  tone?: 'quiet' | 'bad';
}) {
  const body = (
    <>
      <p
        className={`font-mono text-3xl font-semibold tabular-nums ${
          tone === 'bad' ? 'text-[var(--color-bad)]' : ''
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-sm text-[var(--color-muted)]">{label}</p>
    </>
  );

  const className =
    'rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 block';

  return href ? (
    <Link href={href} className={`${className} hover:border-[var(--color-ink)]`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
