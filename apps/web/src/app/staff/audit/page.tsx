import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { getStaffAudit, getStaffIdentity } from '@/lib/staff-api';

export const dynamic = 'force-dynamic';

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Everything staff have looked at and changed, newest first.
 *
 * The same record the database keeps and nobody can edit. Useful for "who
 * changed this?", and for being able to show a customer exactly what we did.
 */
export default async function StaffAuditPage() {
  if (!(await getStaffIdentity())) notFound();

  const events = await getStaffAudit();

  return (
    <>
      <AppNav current="staff" />
      <main className="mx-auto max-w-4xl px-6 py-12">
        <Link
          href="/staff"
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          All businesses
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Activity log</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          The latest 200 staff actions and looks. Entries cannot be edited or deleted.
        </p>

        {!events ? (
          <p className="mt-6 text-sm text-[var(--color-bad)]">Could not load the log.</p>
        ) : events.length === 0 ? (
          <p className="mt-6 text-sm text-[var(--color-muted)]">Nothing yet.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--color-line)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--color-surface)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
                <tr>
                  <th className="whitespace-nowrap px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Who</th>
                  <th className="px-4 py-3 font-medium">What</th>
                  <th className="px-4 py-3 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t border-[var(--color-line)] align-top">
                    <td className="whitespace-nowrap px-4 py-3 text-[var(--color-muted)]">
                      {dateTime(event.createdAt)}
                    </td>
                    <td className="px-4 py-3">{event.staffEmail}</td>
                    <td className="px-4 py-3">
                      {event.organizationId ? (
                        <Link
                          href={`/staff/businesses/${event.organizationId}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {event.action}
                        </Link>
                      ) : (
                        event.action
                      )}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-muted)]">{event.reason ?? '—'}</td>
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
