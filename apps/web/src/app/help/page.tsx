import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { KIND_LABEL, NewSupportRequestForm, STATUS_LABEL } from '@/components/support-forms';
import { getCurrentOrganization } from '@/lib/api';
import { getSupportRequests } from '@/lib/support-api';

export const dynamic = 'force-dynamic';

export default async function HelpPage() {
  if (!(await getCurrentOrganization())) redirect('/login');

  const requests = await getSupportRequests();

  return (
    <>
      <AppNav current="help" />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-semibold tracking-tight">Help</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Questions, something not working, or an idea: send it here and the RelaStack team replies.
          You will get an email when we do.
        </p>

        <div className="mt-6">
          <NewSupportRequestForm />
        </div>

        {!requests ? (
          <p className="mt-8 text-sm text-[var(--color-bad)]">Could not load your requests.</p>
        ) : requests.length === 0 ? (
          <p className="mt-8 text-sm text-[var(--color-muted)]">Nothing sent yet.</p>
        ) : (
          <ul className="mt-8 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)]">
            {requests.map((request) => (
              <li key={request.id}>
                <Link
                  href={`/help/${request.id}`}
                  className="flex flex-wrap justify-between gap-2 p-4"
                >
                  <span>
                    <span className="font-medium">{request.subject}</span>
                    <span className="block text-xs text-[var(--color-muted)]">
                      {KIND_LABEL[request.kind]} · {request.openedByEmail}
                    </span>
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {STATUS_LABEL[request.status]}
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
