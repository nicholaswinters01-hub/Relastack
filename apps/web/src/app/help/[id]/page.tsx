import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppNav } from '@/components/app-nav';
import { SupportReplyForm, SupportThread } from '@/components/support-forms';
import { KIND_LABEL, STATUS_LABEL } from '@/lib/support-labels';
import { getSupportRequest } from '@/lib/support-api';

export const dynamic = 'force-dynamic';

export default async function HelpRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await getSupportRequest(id);
  if (!request) notFound();

  return (
    <>
      <AppNav current="help" />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href="/help"
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          All requests
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{request.subject}</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {KIND_LABEL[request.kind]} · {STATUS_LABEL[request.status]}
        </p>

        <div className="mt-6">
          <SupportThread messages={request.messages} />
        </div>
        <div className="mt-6">
          <SupportReplyForm path={`/api/v1/support/requests/${request.id}/messages`} />
        </div>
      </main>
    </>
  );
}
