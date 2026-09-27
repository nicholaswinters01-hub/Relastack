import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import {
  KIND_LABEL,
  SupportReplyForm,
  SupportStatusButton,
  SupportThread,
} from '@/components/support-forms';
import { getStaffIdentity } from '@/lib/staff-api';
import { getStaffSupportRequest } from '@/lib/support-api';

export const dynamic = 'force-dynamic';

const STAFF_STATUS: Record<string, string> = {
  OPEN: 'Waiting on us',
  WAITING_ON_CUSTOMER: 'Waiting on them',
  RESOLVED: 'Resolved',
};

export default async function StaffHelpRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await getStaffIdentity())) notFound();

  const { id } = await params;
  const request = await getStaffSupportRequest(id);
  if (!request) notFound();

  const statusPath = `/api/v1/staff/support/${request.id}/status`;

  return (
    <>
      <AppNav current="staff" />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href="/staff/help"
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          Help requests
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{request.subject}</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          <Link
            href={`/staff/businesses/${request.organizationId}`}
            className="underline underline-offset-4"
          >
            {request.businessName}
          </Link>{' '}
          · {request.openedByEmail} · {KIND_LABEL[request.kind]} · {STAFF_STATUS[request.status]}
        </p>

        <div className="mt-4 flex gap-2">
          {request.status !== 'RESOLVED' ? (
            <SupportStatusButton path={statusPath} status="RESOLVED" label="Mark resolved" />
          ) : (
            <SupportStatusButton path={statusPath} status="OPEN" label="Reopen" />
          )}
        </div>

        <div className="mt-6">
          <SupportThread messages={request.messages} />
        </div>
        <div className="mt-6">
          <SupportReplyForm path={`/api/v1/staff/support/${request.id}/messages`} staff />
        </div>
      </main>
    </>
  );
}
