import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { getStaffBusinesses, getStaffIdentity, getStaffOverview } from '@/lib/staff-api';

export const dynamic = 'force-dynamic';

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'trialing', label: 'On trial' },
  { key: 'trial-ending', label: 'Trial ends this week' },
  { key: 'renewal-due', label: 'Renewal due in 30 days' },
  { key: 'past-due', label: 'Payment overdue' },
  { key: 'read-only', label: 'Read-only' },
  { key: 'suspended', label: 'Suspended' },
];

const STATUS_LABEL: Record<string, string> = {
  TRIALING: 'Trial',
  ACTIVE: 'Paying',
  PAST_DUE: 'Payment overdue',
  SUSPENDED: 'Read-only',
  CANCELLED: 'Cancelled',
};

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; filter?: string }>;
}) {
  // Not staff, or the API is unreachable: the page does not exist either way.
  if (!(await getStaffIdentity())) notFound();

  const { search = '', filter = 'all' } = await searchParams;
  const [overview, businesses] = await Promise.all([
    getStaffOverview(),
    getStaffBusinesses({ search, filter }),
  ]);

  const tiles = overview
    ? [
        { label: 'Businesses', value: String(overview.businesses) },
        { label: 'On trial', value: String(overview.trialing) },
        { label: 'Trials ending this week', value: String(overview.trialsEndingThisWeek) },
        { label: 'Paying', value: String(overview.paying) },
        { label: 'Renewals due (30 days)', value: String(overview.renewalsDueSoon) },
        { label: 'Payment overdue', value: String(overview.pastDue) },
        { label: 'Read-only', value: String(overview.readOnly) },
        { label: 'Suspended', value: String(overview.suspended) },
        { label: 'Est. monthly revenue', value: money(overview.estimatedMonthlyRevenueCents) },
        { label: 'Collected (30 days)', value: money(overview.collectedLast30DaysCents) },
        { label: 'Credit we owe', value: money(overview.creditOutstandingCents) },
        { label: 'Help requests waiting', value: String(overview.openSupportRequests) },
      ]
    : [];

  return (
    <>
      <AppNav current="staff" />
      <main className="mx-auto max-w-screen-2xl px-6 py-12">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Staff</h1>
          <span className="flex gap-4 text-sm">
            <Link href="/staff/help" className="underline underline-offset-4">
              Help requests
              {overview && overview.openSupportRequests > 0 && ` (${overview.openSupportRequests})`}
            </Link>
            <Link href="/staff/audit" className="underline underline-offset-4">
              Activity log
            </Link>
          </span>
        </div>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Account information only. What a business keeps about its own customers is not visible
          here, by design. Everything you open or change is recorded.
        </p>

        {tiles.length > 0 && (
          <dl className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {tiles.map((tile) => (
              <div
                key={tile.label}
                className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
              >
                <dt className="text-xs text-[var(--color-muted)]">{tile.label}</dt>
                <dd className="mt-1 text-xl font-semibold">{tile.value}</dd>
              </div>
            ))}
          </dl>
        )}

        <form method="get" className="mt-10 flex flex-wrap gap-2">
          <input
            name="search"
            defaultValue={search}
            placeholder="Business name or any member's email"
            className="min-w-64 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
          <input type="hidden" name="filter" value={filter} />
          <button
            type="submit"
            className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)]"
          >
            Search
          </button>
        </form>

        <div className="mt-3 flex flex-wrap gap-2">
          {FILTERS.map((option) => {
            const params = new URLSearchParams();
            if (search) params.set('search', search);
            if (option.key !== 'all') params.set('filter', option.key);
            const active = filter === option.key;

            return (
              <Link
                key={option.key}
                href={`/staff?${params.toString()}`}
                className={`rounded-full border px-3 py-1 text-xs ${
                  active
                    ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
                    : 'border-[var(--color-line)] text-[var(--color-muted)]'
                }`}
              >
                {option.label}
              </Link>
            );
          })}
        </div>

        {!businesses ? (
          <p className="mt-6 text-sm text-[var(--color-bad)]">Could not load businesses.</p>
        ) : businesses.length === 0 ? (
          <p className="mt-6 text-sm text-[var(--color-muted)]">No businesses match.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--color-line)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--color-surface)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Locations</th>
                  <th className="px-4 py-3 font-medium">People</th>
                  <th className="whitespace-nowrap px-4 py-3 font-medium">Last active</th>
                </tr>
              </thead>
              <tbody>
                {businesses.map((business) => (
                  <tr key={business.id} className="border-t border-[var(--color-line)]">
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/businesses/${business.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {business.name}
                      </Link>
                      <div className="text-xs text-[var(--color-muted)]">
                        {business.ownerEmail ?? 'No owner'}
                      </div>
                    </td>
                    <td className="px-4 py-3">{business.planName ?? '—'}</td>
                    <td className="px-4 py-3">
                      {business.status === 'SUSPENDED' ? (
                        <span className="text-[var(--color-bad)]">Suspended</span>
                      ) : business.subscriptionStatus ? (
                        <>
                          {STATUS_LABEL[business.subscriptionStatus]}
                          {business.subscriptionStatus === 'TRIALING' && business.trialEndsAt && (
                            <span className="text-xs text-[var(--color-muted)]">
                              {' '}
                              · ends {shortDate(business.trialEndsAt)}
                            </span>
                          )}
                          {business.paidThrough && (
                            <span className="text-xs text-[var(--color-muted)]">
                              {' '}
                              · {business.subscriptionStatus === 'PAST_DUE'
                                ? 'was due'
                                : 'paid to'}{' '}
                              {shortDate(business.paidThrough)}
                            </span>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3">{business.locationCount}</td>
                    <td className="px-4 py-3">{business.memberCount}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-[var(--color-muted)]">
                      {shortDate(business.lastActiveAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  );
}
