'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { HelpRequest } from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

async function post(path: string, body?: unknown): Promise<string | null> {
  try {
    const response = await apiWrite(path, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    return payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.';
  } catch {
    return 'Could not reach the server.';
  }
}

const since = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** Acknowledge and close buttons for a call, for the board and the job page. */
export function HelpActions({ request, canClose }: { request: HelpRequest; canClose: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(action: 'acknowledge' | 'resolve') {
    setError(null);
    setBusy(true);
    const failure = await post(`/api/v1/help-requests/${request.id}/${action}`);
    setBusy(false);
    if (failure) setError(failure);
    else router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {request.canManage && request.status === 'OPEN' && (
        <button
          type="button"
          onClick={() => void act('acknowledge')}
          disabled={busy}
          className="rounded-lg bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          I&apos;m on it
        </button>
      )}
      {(request.canManage || canClose) && request.status !== 'RESOLVED' && (
        <button
          type="button"
          onClick={() => void act('resolve')}
          disabled={busy}
          className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs disabled:opacity-50"
        >
          Sorted
        </button>
      )}
      {error && <span className="text-xs text-[var(--color-bad)]">{error}</span>}
    </span>
  );
}

/**
 * "Need a manager" on the job page. The crew calls; the branch's managers
 * are told and answer from the board or here.
 */
export function HelpCall({
  jobId,
  request,
  canRequest,
}: {
  jobId: string;
  request: HelpRequest | null;
  canRequest: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = request && request.status !== 'RESOLVED' ? request : null;

  if (!live && !canRequest) return null;

  async function call() {
    setError(null);
    setBusy(true);
    const failure = await post(`/api/v1/jobs/${jobId}/help`, { note: note.trim() || undefined });
    setBusy(false);
    if (failure) setError(failure);
    else {
      setOpen(false);
      setNote('');
      router.refresh();
    }
  }

  return (
    <section
      className={`mt-6 rounded-xl border bg-[var(--color-surface)] p-5 ${
        live ? 'border-[var(--color-bad)]' : 'border-[var(--color-line)]'
      }`}
    >
      {live ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">
              {live.status === 'OPEN'
                ? 'A manager has been called'
                : `${live.acknowledgedByName} is on it`}
            </p>
            <p className="text-xs text-[var(--color-muted)]">
              {live.requestedByName} called at {since(live.createdAt)}
              {live.note && ` · "${live.note}"`}
            </p>
          </div>
          <HelpActions request={live} canClose={canRequest} />
        </div>
      ) : open ? (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            What do you need? (optional)
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Customer wants a quote for extra rooms"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm"
            />
          </label>
          {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void call()}
              disabled={busy}
              className="rounded-lg bg-[var(--color-bad)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Calling…' : 'Call a manager'}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 text-sm underline underline-offset-4"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[var(--color-muted)]">
            Something the office can&apos;t help with? Your branch manager gets it straight away.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg border border-[var(--color-bad)] px-3 py-2 text-sm font-medium text-[var(--color-bad)]"
          >
            Need a manager
          </button>
        </div>
      )}
    </section>
  );
}
