import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { KIND_LABEL } from '@/lib/support-labels';
import { getStaffIdentity } from '@/lib/staff-api';
import { getStaffSupport } from '@/lib/support-api';

export const dynamic = 'force-dynamic';

const FILTERS = [
  { key: 'open', label: 'Waiting on us' },
  { key: 'waiting', label: 'Waiting on them' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

export default async function StaffHelpPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  if (!(await getStaffIdentity())) notFound();

  const { filter = 'open' } = await searchParams;
  const requests = await getStaffSupport(filter);

  return (
    <>
      <AppNav current="staff" />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <Link
          href="/staff"
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          Staff
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Help requests</h1>

        <div className="mt-6 flex flex-wrap gap-2">
          {FILTERS.map((option) => (
            <Link
              key={option.key}
              href={`/staff/help?filter=${option.key}`}
              className={`rounded-full border px-3 py-1 text-xs ${
                filter === option.key
                  ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
                  : 'border-[var(--color-line)] text-[var(--color-muted)]'
              }`}
            >
              {option.label}
            </Link>
          ))}
        </div>

        {!requests ? (
          <p className="mt-6 text-sm text-[var(--color-bad)]">Could not load requests.</p>
        ) : requests.length === 0 ? (
          <p className="mt-6 text-sm text-[var(--color-muted)]">Nothing here.</p>
        ) : (
          <ul className="mt-6 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)]">
            {requests.map((request) => (
              <li key={request.id}>
                <Link
                  href={`/staff/help/${request.id}`}
                  className="flex flex-wrap justify-between gap-2 p-4"
                >
                  <span>
                    <span className="font-medium">{request.subject}</span>
                    <span className="block text-xs text-[var(--color-muted)]">
                      {request.businessName} · {request.openedByEmail} · {KIND_LABEL[request.kind]}
                    </span>
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {new Date(request.updatedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
