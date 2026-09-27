'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ORGANIZATION_NAME_MAX_LENGTH, ORGANIZATION_NAME_MIN_LENGTH } from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

/**
 * The business name, editable in place by whoever may change company settings.
 *
 * Showing the button only to them is a courtesy; the API refuses everyone
 * else. The web address (slug) deliberately stays as it is, so existing links
 * keep working.
 */
export function OrganizationNameForm({ name, canEdit }: { name: string; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await apiWrite('/api/v1/organizations/current', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: value }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return;
      }

      setEditing(false);
      // The name also sits in the navigation and page titles.
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
        <span>{name}</span>
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setValue(name);
              setEditing(true);
            }}
            className="text-xs underline underline-offset-4"
          >
            Rename
          </button>
        )}
      </span>
    );
  }

  return (
    <form onSubmit={submit} className="flex w-full flex-col items-end gap-2">
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        required
        minLength={ORGANIZATION_NAME_MIN_LENGTH}
        maxLength={ORGANIZATION_NAME_MAX_LENGTH}
        autoFocus
        aria-label="Business name"
        className="w-full max-w-sm rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-1.5 text-sm"
      />
      {error && <p className="text-xs text-[var(--color-bad)]">{error}</p>}
      <span className="flex gap-3">
        <button
          type="submit"
          disabled={busy || value.trim() === name}
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
