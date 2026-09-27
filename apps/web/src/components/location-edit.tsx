'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import type { Location } from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

/** The zones most customers are in, by the names people use. */
const COMMON_ZONES: Array<{ zone: string; label: string }> = [
  { zone: 'America/New_York', label: 'Eastern (New York, Tampa, Atlanta)' },
  { zone: 'America/Chicago', label: 'Central (Chicago, Dallas, Houston)' },
  { zone: 'America/Denver', label: 'Mountain (Denver, Salt Lake City)' },
  { zone: 'America/Phoenix', label: 'Arizona (no daylight saving)' },
  { zone: 'America/Los_Angeles', label: 'Pacific (Los Angeles, Seattle)' },
  { zone: 'America/Anchorage', label: 'Alaska' },
  { zone: 'Pacific/Honolulu', label: 'Hawaii' },
];

/**
 * A time-zone picker instead of a text box: a typo there puts every job at
 * the location an hour or more out. Common US zones first, by name; every
 * other zone the browser knows below.
 */
export function TimezoneSelect({
  name,
  defaultValue,
  value,
  onChange,
}: {
  name?: string;
  defaultValue?: string;
  value?: string;
  onChange?: (zone: string) => void;
}) {
  const others = useMemo(() => {
    const common = new Set(COMMON_ZONES.map((z) => z.zone));
    let all: string[] = [];
    try {
      all =
        (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
          'timeZone',
        ) ?? [];
    } catch {
      all = [];
    }
    return all.filter((zone) => !common.has(zone));
  }, []);

  const current = value ?? defaultValue;
  const known =
    current && (COMMON_ZONES.some((z) => z.zone === current) || others.includes(current));

  return (
    <select
      name={name}
      defaultValue={value === undefined ? defaultValue : undefined}
      value={value}
      onChange={onChange ? (event) => onChange(event.target.value) : undefined}
      aria-label="Time zone"
      className={FIELD}
    >
      {current && !known && <option value={current}>{current}</option>}
      <optgroup label="United States">
        {COMMON_ZONES.map((z) => (
          <option key={z.zone} value={z.zone}>
            {z.label}
          </option>
        ))}
      </optgroup>
      {others.length > 0 && (
        <optgroup label="Everywhere else">
          {others.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll('_', ' ')}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

/**
 * Editing a location: a typo in the name, a move, a second "Office" that
 * means the first needs a clearer name.
 *
 * Every field is sent, so emptying one clears it. Marking a location inactive
 * keeps everything that happened there; it just stops being somewhere new
 * work goes.
 */
export function LocationEditor({ location, onDone }: { location: Location; onDone: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStatus, setConfirmStatus] = useState(false);

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await apiWrite(`/api/v1/locations/${location.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError('Could not reach the server.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  // The API replaces the whole record, so a status change carries the rest.
  const current = {
    name: location.name,
    addressLine1: location.addressLine1 ?? '',
    addressLine2: location.addressLine2 ?? '',
    city: location.city ?? '',
    region: location.region ?? '',
    postalCode: location.postalCode ?? '',
    country: location.country ?? '',
    phone: location.phone ?? '',
    email: location.email ?? '',
    timezone: location.timezone,
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '');
    const ok = await patch({
      name: text('name'),
      addressLine1: text('addressLine1'),
      addressLine2: text('addressLine2'),
      city: text('city'),
      region: text('region'),
      postalCode: text('postalCode'),
      country: text('country'),
      phone: text('phone'),
      email: text('email'),
      timezone: text('timezone'),
    });
    if (ok) onDone();
  }

  const field = (key: keyof typeof current, label: string, props: Record<string, unknown> = {}) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      <input name={key} defaultValue={current[key]} className={FIELD} {...props} />
    </label>
  );

  const active = location.status === 'ACTIVE';

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-[var(--color-line)] pt-4">
      <form onSubmit={save} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            {field('name', 'Name', { required: true, maxLength: 120 })}
          </div>
          <div className="sm:col-span-2">{field('addressLine1', 'Address')}</div>
          <div className="sm:col-span-2">{field('addressLine2', 'Address line 2')}</div>
          {field('city', 'City')}
          {field('region', 'State / region')}
          {field('postalCode', 'Postal code')}
          {field('country', 'Country')}
          {field('phone', 'Phone', { type: 'tel' })}
          {field('email', 'Email', { type: 'email' })}
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-xs text-[var(--color-muted)]">
              Time zone (jobs here are shown in it)
            </span>
            <TimezoneSelect name="timezone" defaultValue={location.timezone} />
          </label>
        </div>

        {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onDone} className="text-sm underline underline-offset-4">
            Cancel
          </button>
        </div>
      </form>

      <div className="border-t border-[var(--color-line)] pt-3 text-sm">
        {confirmStatus ? (
          <div className="flex flex-wrap items-center gap-3">
            <span>
              {active
                ? `Mark ${location.name} inactive? Its jobs, customers and history stay; it just stops being offered for new work.`
                : `Make ${location.name} active again?`}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (await patch({ ...current, status: active ? 'INACTIVE' : 'ACTIVE' })) onDone();
              }}
              className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {active ? 'Mark inactive' : 'Make active'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmStatus(false)}
              className="text-xs underline underline-offset-4"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmStatus(true)}
            className="text-xs text-[var(--color-muted)] underline underline-offset-4"
          >
            {active ? 'Mark this location inactive' : 'Make this location active again'}
          </button>
        )}
      </div>
    </div>
  );
}
