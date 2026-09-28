'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { apiWrite } from '@/lib/live-sync';

interface Field {
  name: string;
  label: string;
  /**
   * `date` sends the end of that day as an instant, `day` sends midday (for
   * "when did this happen", where the end of the day could be tomorrow in UTC),
   * `money` takes dollars and sends whole cents.
   */
  type: 'date' | 'day' | 'select' | 'money' | 'text';
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string;
  /** Left out of the request when empty. Everything else is required. */
  optional?: boolean;
  hint?: string;
}

/** "29", "29.5", "$1,200.00" → cents. Null when it is not an amount. */
function toCents(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

const inputClass =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5';

interface StaffActionProps {
  label: string;
  /** API path under /api/v1/staff. */
  path: string;
  fields?: Field[];
  /** Fixed values sent with every submission, e.g. the status being set. */
  fixed?: Record<string, string | boolean>;
  danger?: boolean;
  /** The action returns a link to hand to someone (a re-issued invitation). */
  returnsLink?: boolean;
}

/**
 * One staff action: a button that opens a short form asking why.
 *
 * The reason is required by the API and lands in the activity log; the form
 * asks for it up front so nobody discovers that after typing everything else.
 */
export function StaffAction({
  label,
  path,
  fields = [],
  fixed = {},
  danger,
  returnsLink,
}: StaffActionProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const body: Record<string, string | number | boolean> = {
      ...fixed,
      reason: String(form.get('reason') ?? ''),
    };

    for (const field of fields) {
      const value = String(form.get(field.name) ?? '').trim();
      if (value === '' && field.optional) continue;

      if (field.type === 'money') {
        const cents = toCents(value);
        if (cents === null) {
          setError(`${field.label}: enter an amount like 29 or 29.50`);
          setBusy(false);
          return;
        }
        body[field.name] = cents;
      } else if (field.type === 'date') {
        // A date input gives a bare day; the API wants an instant. End of that
        // day, local time, so "extend to the 30th" includes the 30th.
        body[field.name] = new Date(`${value}T23:59:00`).toISOString();
      } else if (field.type === 'day') {
        body[field.name] = new Date(`${value}T12:00:00`).toISOString();
      } else {
        body[field.name] = value;
      }
    }

    try {
      const response = await apiWrite(`/api/v1/staff/${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return;
      }

      if (returnsLink) {
        const payload = await response.json();
        setLink(payload.acceptUrl);
      } else {
        setOpen(false);
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (link) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-line)] p-3 text-sm">
        <span className="text-[var(--color-muted)]">
          New link. Send it to them yourself; the old one no longer works.
        </span>
        <code className="break-all rounded bg-[var(--color-canvas)] p-2 text-xs">{link}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(link);
            setCopied(true);
          }}
          className="self-start text-xs underline underline-offset-4"
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
          danger
            ? 'border-[var(--color-bad)] text-[var(--color-bad)]'
            : 'border-[var(--color-line)]'
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex w-full flex-col gap-2 rounded-lg border border-[var(--color-line)] p-3 text-sm"
    >
      <span className="font-medium">{label}</span>

      {fields.map((field) => (
        <label key={field.name} className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-muted)]">
            {field.label}
            {field.optional && ' (optional)'}
          </span>
          {field.type === 'select' ? (
            <select name={field.name} defaultValue={field.defaultValue} className={inputClass}>
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={field.type === 'date' || field.type === 'day' ? 'date' : 'text'}
              inputMode={field.type === 'money' ? 'decimal' : undefined}
              name={field.name}
              required={!field.optional}
              defaultValue={field.defaultValue}
              placeholder={field.type === 'money' ? '0.00' : undefined}
              className={inputClass}
            />
          )}
          {field.hint && <span className="text-xs text-[var(--color-muted)]">{field.hint}</span>}
        </label>
      ))}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-muted)]">Why? (kept in the activity log)</span>
        <input
          name="reason"
          required
          minLength={5}
          maxLength={500}
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-2 py-1.5"
        />
      </label>

      {error && <p className="text-xs text-[var(--color-bad)]">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
            danger ? 'bg-[var(--color-bad)]' : 'bg-[var(--color-ink)] text-[var(--color-canvas)]'
          }`}
        >
          {busy ? 'Working…' : 'Confirm'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="text-xs underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Internal notes. Never visible to the business. */
export function StaffNoteForm({ businessId }: { businessId: string }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await apiWrite(`/api/v1/staff/businesses/${businessId}/notes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return;
      }

      setBody('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        maxLength={5000}
        placeholder="What happened, what you told them, what to follow up on."
        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
      />
      {error && <p className="text-xs text-[var(--color-bad)]">{error}</p>}
      <button
        type="submit"
        disabled={busy || body.trim().length === 0}
        className="self-start rounded-lg bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Add note'}
      </button>
    </form>
  );
}
