import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { PestRecordsTable } from '@/components/pest-records-table';
import { getCurrentOrganization, getModules, getPestRecords } from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

const isDay = (value: string | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;

function monthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/**
 * Every application record in a date range: for an inspection, an audit, or
 * the office checking the week. Scoped like the schedule, so a branch manager
 * sees and exports their branches' records.
 */
export default async function PestRecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const query = await searchParams;
  const from = isDay(query.from) ?? monthStart();
  const to = isDay(query.to) ?? new Date().toISOString().slice(0, 10);

  const modules = await getModules();
  const pestOn = modules.some((m) => m.key === MODULES.PEST_CONTROL && m.enabled);
  const canRead = canAnywhere(organization.permissions, PERMISSIONS.JOB_READ);
  const records = pestOn && canRead ? await getPestRecords({ from, to }) : null;
  const csv = `/api/v1/packs/pest-control/records.csv?${new URLSearchParams({ from, to })}`;

  return (
    <>
      <AppNav current="records" />
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">Application records</h1>

        {!pestOn ? (
          <p className="mt-3 text-[var(--color-muted)]">
            Application records come with the Pest Control pack.{' '}
            <Link href="/modules" className="underline underline-offset-4">
              Modules
            </Link>
          </p>
        ) : !canRead ? (
          <p className="mt-3 text-[var(--color-muted)]">Your role does not include the schedule.</p>
        ) : (
          <>
            <p className="mt-2 text-[var(--color-muted)]">
              Every product applied on every visit, as it was recorded on the day.
            </p>

            <form className="mt-6 flex flex-wrap items-end gap-3" method="get">
              <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
                From
                <input
                  type="date"
                  name="from"
                  defaultValue={from}
                  className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
                To
                <input
                  type="date"
                  name="to"
                  defaultValue={to}
                  className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm"
                />
              </label>
              <button
                type="submit"
                className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm"
              >
                Show
              </button>
              <a
                href={csv}
                className="rounded-lg bg-[var(--color-ink)] px-3 py-2 text-sm font-medium text-[var(--color-canvas)]"
              >
                Download spreadsheet (CSV)
              </a>
            </form>

            {records === null ? (
              <p className="mt-6 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
                We could not load the records just now.
              </p>
            ) : (
              <PestRecordsTable records={records} />
            )}
          </>
        )}
      </main>
    </>
  );
}
