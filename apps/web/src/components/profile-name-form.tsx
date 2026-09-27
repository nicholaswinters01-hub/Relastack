'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/**
 * Your own name, editable in place.
 *
 * It is what colleagues see, and what an invitation you send says it is from.
 */
export function ProfileNameForm({
  firstName,
  lastName,
}: {
  firstName: string | null;
  lastName: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState(firstName ?? '');
  const [last, setLast] = useState(lastName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fullName = [firstName, lastName].filter(Boolean).join(' ');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/v1/auth/me', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ firstName: first, lastName: last }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return;
      }

      setEditing(false);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <span className="flex items-baseline justify-end gap-3">
        <span>{fullName || '—'}</span>
        <button
          type="button"
          onClick={() => {
            setFirst(firstName ?? '');
            setLast(lastName ?? '');
            setEditing(true);
          }}
          className="text-xs underline underline-offset-4"
        >
          {fullName ? 'Edit' : 'Add your name'}
        </button>
      </span>
    );
  }

  const inputClass =
    'w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-1.5 text-sm';

  return (
    <form onSubmit={submit} className="flex w-full flex-col items-end gap-2">
      <span className="flex w-full max-w-sm gap-2">
        <input
          value={first}
          onChange={(event) => setFirst(event.target.value)}
          maxLength={100}
          autoFocus
          autoComplete="given-name"
          placeholder="First name"
          aria-label="First name"
          className={inputClass}
        />
        <input
          value={last}
          onChange={(event) => setLast(event.target.value)}
          maxLength={100}
          autoComplete="family-name"
          placeholder="Last name"
          aria-label="Last name"
          className={inputClass}
        />
      </span>
      {error && <p className="text-xs text-[var(--color-bad)]">{error}</p>}
      <span className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          className="text-xs underline underline-offset-4"
        >
          Cancel
        </button>
      </span>
    </form>
  );
}
