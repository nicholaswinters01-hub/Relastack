import { LocalTime } from '@/components/local-time';
import { Wordmark } from '@/components/wordmark';
import { requireAdmin } from '@/lib/admin-auth';
import { loadEnv } from '@/lib/env';
import { listSignups, type SignupRow } from '@/lib/waitlist-postgres';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  // First line, before anything is read. The page is the enforcement point;
  // there is no link to it anywhere, but that is not what keeps it private.
  const admin = await requireAdmin();

  let data: { total: number; rows: SignupRow[] } | null = null;
  let problem: string | null = null;

  if (loadEnv().WAITLIST_PROVIDER !== 'postgres') {
    problem =
      'Signups are not being stored in a database on this deployment (WAITLIST_PROVIDER is not "postgres").';
  } else {
    try {
      data = await listSignups();
    } catch (error) {
      console.error('[admin] could not read signups', error);
      problem = 'Could not reach the database. Try again in a moment.';
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <Wordmark className="text-xl" />
          <span className="font-mono text-xs uppercase tracking-widest text-[var(--color-muted)]">
            Admin
          </span>
        </div>

        <form method="post" action="/api/admin/logout" className="flex items-center gap-3 text-sm">
          <span className="text-[var(--color-muted)]">{admin}</span>
          <button type="submit" className="underline underline-offset-4">
            Sign out
          </button>
        </form>
      </header>

      <h1 className="mt-10 text-2xl font-semibold tracking-tight">Waitlist</h1>

      {problem && <p className="mt-4 text-sm text-[var(--color-bad)]">{problem}</p>}

      {data && (
        <>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {data.total === 1 ? '1 signup' : `${data.total} signups`}
            {data.total > data.rows.length && ` — showing the newest ${data.rows.length}`}
          </p>

          {data.rows.length === 0 ? (
            <p className="mt-8 text-sm text-[var(--color-muted)]">Nobody yet.</p>
          ) : (
            <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--color-line)]">
              <table className="w-full text-left text-sm">
                <thead className="bg-[var(--color-surface)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
                  <tr>
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">What they do</th>
                    <th className="whitespace-nowrap px-4 py-3 font-medium">Signed up</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.email} className="border-t border-[var(--color-line)]">
                      <td className="px-4 py-3 font-medium">{row.email}</td>
                      <td className="px-4 py-3 text-[var(--color-muted)]">{row.note ?? '—'}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-[var(--color-muted)]">
                        <LocalTime iso={row.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
