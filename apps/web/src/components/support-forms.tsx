'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { SupportMessage } from '@platform/shared';

const inputClass =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm';
const buttonClass =
  'self-start rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50';

async function post(path: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    return payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.';
  } catch {
    return 'Could not reach the server.';
  }
}

export const KIND_LABEL: Record<string, string> = {
  QUESTION: 'Question',
  PROBLEM: 'Something is wrong',
  IDEA: 'Idea or request',
};

export const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Waiting on RelaStack',
  WAITING_ON_CUSTOMER: 'Replied',
  RESOLVED: 'Resolved',
};

/** A new help request. */
export function NewSupportRequestForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('QUESTION');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/v1/support/requests', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, subject, body }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return;
      }

      router.push(`/help/${payload.id}`);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={buttonClass}>
        Ask for help
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">What is it?</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
          {Object.entries(KIND_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">In a few words</span>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          required
          minLength={3}
          maxLength={200}
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Tell us more</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          rows={5}
          maxLength={5000}
          placeholder="What were you trying to do, and what happened?"
          className={inputClass}
        />
      </label>
      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A reply on a request. Staff also choose where it leaves the request. */
export function SupportReplyForm({ path, staff }: { path: string; staff?: boolean }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('WAITING_ON_CUSTOMER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const failure = await post(path, staff ? { body, status } : { body });
    setBusy(false);

    if (failure) {
      setError(failure);
      return;
    }
    setBody('');
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        required
        rows={4}
        maxLength={5000}
        placeholder={staff ? 'Your reply. They see it signed "RelaStack".' : 'Add a reply'}
        className={inputClass}
      />
      {staff && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-[var(--color-muted)]">Then mark it</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
            <option value="WAITING_ON_CUSTOMER">Waiting on them</option>
            <option value="RESOLVED">Resolved</option>
            <option value="OPEN">Still open (we owe more)</option>
          </select>
        </label>
      )}
      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
      <button type="submit" disabled={busy || body.trim() === ''} className={buttonClass}>
        {busy ? 'Sending…' : staff ? 'Send reply' : 'Reply'}
      </button>
    </form>
  );
}

/** Mark a request resolved or open again without replying. Staff only. */
export function SupportStatusButton({
  path,
  status,
  label,
}: {
  path: string;
  status: string;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await post(path, { status });
        setBusy(false);
        router.refresh();
      }}
      className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
    >
      {busy ? '…' : label}
    </button>
  );
}

export function SupportThread({ messages }: { messages: SupportMessage[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {messages.map((message) => (
        <li
          key={message.id}
          className={`rounded-xl border p-4 text-sm ${
            message.fromStaff
              ? 'border-[var(--color-ink)] bg-[var(--color-surface)]'
              : 'border-[var(--color-line)] bg-[var(--color-surface)]'
          }`}
        >
          <p className="whitespace-pre-wrap">{message.body}</p>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            {message.authorLabel} ·{' '}
            {new Date(message.createdAt).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
        </li>
      ))}
    </ol>
  );
}
