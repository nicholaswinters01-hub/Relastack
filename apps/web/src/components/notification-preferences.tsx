'use client';

import { useState } from 'react';
import type { NotificationPreference } from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

/**
 * What you are told about.
 *
 * Both switches can be off, and that is allowed on purpose: a product that
 * refuses to stop talking to you is one you stop reading.
 *
 * Only what the API offers appears here. Two things deliberately have no row:
 * the account going read-only, because losing access without warning is worse
 * than an unwanted email, and the invitation email, whose recipient is not yet
 * a member of anything to hold a preference.
 */
export function NotificationPreferences({
  preferences,
}: {
  preferences: NotificationPreference[];
}) {
  const [rows, setRows] = useState(preferences);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function set(row: NotificationPreference, channel: 'inApp' | 'email', value: boolean) {
    setBusy(`${row.type}:${channel}`);
    setError(null);

    // Optimistic, and rolled back below. A checkbox that lags a round trip
    // feels broken even when it is working.
    const previous = rows;
    setRows(rows.map((r) => (r.type === row.type ? { ...r, [channel]: value } : r)));

    try {
      const response = await apiWrite('/api/v1/notifications/preferences', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: row.type,
          inApp: row.inApp,
          email: row.email,
          [channel]: value,
        }),
      });

      if (!response.ok) {
        setRows(previous);
        setError('That preference could not be saved.');
        return;
      }

      const body = await response.json();
      setRows(body.preferences);
    } catch {
      setRows(previous);
      setError('That preference could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      id="notifications"
      className="mt-6 scroll-mt-20 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6"
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Notifications
      </h2>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        You are only ever told about work addressed to you, and about money. There is no digest of
        everything the company did today.
      </p>

      {error && <p className="mt-4 text-sm text-[var(--color-bad)]">{error}</p>}

      <div className="mt-4">
        <div className="flex items-center gap-4 border-b border-[var(--color-line)] pb-2">
          <span className="flex-1" />
          <span className="w-14 text-center text-xs uppercase tracking-wide text-[var(--color-muted)]">
            In app
          </span>
          <span className="w-14 text-center text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Email
          </span>
        </div>

        {rows.map((row) => (
          <div
            key={row.type}
            className="flex items-center gap-4 border-b border-[var(--color-line)] py-3 last:border-0"
          >
            <div className="flex-1">
              <p className="text-sm font-medium">{row.label}</p>
              <p className="mt-0.5 text-xs text-[var(--color-muted)]">{row.description}</p>
            </div>

            {(['inApp', 'email'] as const).map((channel) => (
              <span key={channel} className="w-14 text-center">
                <input
                  type="checkbox"
                  checked={row[channel]}
                  disabled={busy === `${row.type}:${channel}`}
                  onChange={(event) => void set(row, channel, event.target.checked)}
                  aria-label={`${row.label} — ${channel === 'inApp' ? 'in app' : 'email'}`}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
