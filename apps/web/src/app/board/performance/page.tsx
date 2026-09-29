import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { BoardBranchPicker } from '@/components/board-branch-picker';
import { BoardTabs } from '@/components/board-tabs';
import { PerformanceTable } from '@/components/performance-table';
import { getCurrentOrganization, getModules, getPerformance } from '@/lib/api';
import { dayLabel, measureOf, periods } from '@/lib/performance-labels';
import { canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

/**
 * How people are doing at the branches you run: who stands out, and everyone's
 * numbers side by side. Each column comes from a module the business has, and
 * each count carries its context so a quiet month is not read as a bad one.
 */
export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string; period?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const query = await searchParams;
  const options = periods();
  const period = options.find((option) => option.key === query.period) ?? options[1];
  const canReview = canAnywhere(organization.permissions, PERMISSIONS.MEMBER_REVIEW);
  const modules = await getModules();
  const schedulingOn = modules.some((m) => m.key === MODULES.SCHEDULING && m.enabled);
  const view = canReview
    ? await getPerformance({ from: period.from, to: period.to, locationId: query.location })
    : null;

  const withPeriod = (key: string) => {
    const params = new URLSearchParams();
    if (key !== 'month') params.set('period', key);
    if (query.location) params.set('location', query.location);
    const search = params.toString();
    return search ? `/board/performance?${search}` : '/board/performance';
  };

  return (
    <>
      <AppNav current="board" />
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <BoardTabs
          current="performance"
          showToday={schedulingOn && canAnywhere(organization.permissions, PERMISSIONS.JOB_WRITE)}
          showPerformance={canReview}
        />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Performance</h1>
            {view && (
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                {dayLabel(view.from)} – {dayLabel(view.to)} ·{' '}
                {view.scope.organizationWide
                  ? 'Every branch'
                  : view.scope.locations.map((location) => location.name).join(', ') ||
                    'No branches'}
              </p>
            )}
          </div>
          {view && view.scope.locations.length > 1 && (
            <BoardBranchPicker
              locations={view.scope.locations}
              selected={query.location ?? null}
              basePath="/board/performance"
              query={query.period ? `period=${query.period}` : ''}
            />
          )}
        </div>

        {!canReview ? (
          <p className="mt-4 text-[var(--color-muted)]">
            Performance is for managers. Your own numbers are on{' '}
            <Link href="/account" className="underline underline-offset-4">
              your account
            </Link>
            .
          </p>
        ) : !view ? (
          <p className="mt-6 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
            We could not load performance just now.
          </p>
        ) : (
          <>
            <div className="mt-6 flex flex-wrap gap-2">
              {options.map((option) => (
                <Link
                  key={option.key}
                  href={withPeriod(option.key)}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    option.key === period.key
                      ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
                      : 'border-[var(--color-line)] text-[var(--color-muted)]'
                  }`}
                >
                  {option.label}
                </Link>
              ))}
            </div>

            {view.standouts.length > 0 && (
              <section className="mt-8">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
                  Standouts
                </h2>
                <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {view.standouts.map((standout) => {
                    const measure = measureOf(standout.measure);
                    return (
                      <li
                        key={standout.measure}
                        className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
                      >
                        <p className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                          Most {measure.label.toLowerCase()} {measure.count}
                        </p>
                        <p className="mt-1 text-sm font-semibold">{standout.names.join(', ')}</p>
                        <p className="text-2xl font-semibold tabular-nums">{standout.count}</p>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <section className="mt-8">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
                Everyone
              </h2>
              {view.people.length === 0 ? (
                <p className="mt-3 text-sm text-[var(--color-muted)]">
                  Nobody works at these branches yet.
                </p>
              ) : (
                <PerformanceTable measures={view.measures} people={view.people} />
              )}
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                Work counts where it happened: a job at its branch, a lead or contract at the
                customer&apos;s branch. Calling for a manager never counts against anyone.
              </p>
            </section>
          </>
        )}
      </main>
    </>
  );
}
