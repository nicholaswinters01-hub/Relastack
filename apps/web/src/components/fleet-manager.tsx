'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { FleetAsset, FleetAssetKind, FleetMeter } from '@platform/shared';
import {
  KIND_LABEL,
  STATE_CLASS,
  STATE_LABEL,
  STATUS_LABEL,
  formatReading,
} from '@/lib/fleet-format';
import { apiWrite } from '@/lib/live-sync';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

export interface Choice {
  id: string;
  name: string;
}

function NewAssetForm({
  branches,
  people,
  onDone,
}: {
  branches: Choice[];
  people: Choice[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<FleetAssetKind>('VEHICLE');
  const [locationId, setLocationId] = useState(branches[0]?.id ?? '');
  const [meter, setMeter] = useState<FleetMeter>('MILES');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [plate, setPlate] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [driver, setDriver] = useState('');
  const [reading, setReading] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function chooseKind(next: FleetAssetKind) {
    setKind(next);
    // Sensible meters: miles on the road, hours on an engine, none on a trailer.
    setMeter(next === 'VEHICLE' ? 'MILES' : next === 'EQUIPMENT' ? 'NONE' : 'NONE');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const yearValue = year.trim() === '' ? null : Number(year);
    const readingValue = reading.trim() === '' ? null : Number(reading);
    if (Number.isNaN(yearValue) || Number.isNaN(readingValue)) {
      setError('Year and reading must be numbers.');
      return;
    }

    setBusy(true);
    try {
      const response = await apiWrite('/api/v1/fleet/assets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          kind,
          locationId,
          meter,
          make,
          model,
          year: yearValue,
          plate,
          identifier,
          assignedMembershipId: driver || null,
          initialReading: meter === 'NONE' ? null : readingValue,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return;
      }
      router.push(`/fleet/${payload.id}`);
      onDone();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const label = 'flex flex-col gap-1 text-xs text-[var(--color-muted)]';

  return (
    <form
      onSubmit={submit}
      className="mt-4 flex flex-col gap-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
    >
      <h2 className="text-sm font-semibold">Add a vehicle or equipment</h2>

      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind">
        {(['VEHICLE', 'TRAILER', 'EQUIPMENT'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="radio"
            aria-checked={kind === entry}
            onClick={() => chooseKind(entry)}
            className={`rounded-full border px-3 py-1 text-xs ${
              kind === entry
                ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
                : 'border-[var(--color-line)] text-[var(--color-muted)]'
            }`}
          >
            {KIND_LABEL[entry]}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className={`${label} sm:col-span-2`}>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={FIELD}
            required
            maxLength={60}
            placeholder={kind === 'EQUIPMENT' ? 'Backpack sprayer 2' : 'Van 3'}
            autoFocus
          />
        </label>
        <label className={label}>
          Home branch
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            className={FIELD}
          >
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Make
          <input value={make} onChange={(e) => setMake(e.target.value)} className={FIELD} />
        </label>
        <label className={label}>
          Model
          <input value={model} onChange={(e) => setModel(e.target.value)} className={FIELD} />
        </label>
        <label className={label}>
          Year
          <input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            inputMode="numeric"
            className={FIELD}
          />
        </label>
        {kind !== 'EQUIPMENT' && (
          <label className={label}>
            Plate
            <input value={plate} onChange={(e) => setPlate(e.target.value)} className={FIELD} />
          </label>
        )}
        <label className={label}>
          {kind === 'EQUIPMENT' ? 'Serial number' : 'VIN'}
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className={FIELD}
          />
        </label>
        <label className={label}>
          Usual driver or user
          <select value={driver} onChange={(e) => setDriver(e.target.value)} className={FIELD}>
            <option value="">Nobody in particular</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Meter
          <select
            value={meter}
            onChange={(e) => setMeter(e.target.value as FleetMeter)}
            className={FIELD}
          >
            <option value="MILES">Miles</option>
            <option value="HOURS">Engine hours</option>
            <option value="NONE">No meter</option>
          </select>
        </label>
        {meter !== 'NONE' && (
          <label className={label}>
            {meter === 'MILES' ? 'Odometer today' : 'Hours today'} (optional)
            <input
              value={reading}
              onChange={(e) => setReading(e.target.value)}
              inputMode="decimal"
              className={FIELD}
            />
          </label>
        )}
      </div>

      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !locationId}
          className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="px-3 text-sm underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The fleet: every vehicle and piece of equipment the reader can see, what
 * its meter last said, and whether any service is due.
 */
export function FleetManager({
  assets,
  branches,
  people,
  showingRetired,
}: {
  assets: FleetAsset[];
  /** Branches where the reader may add assets. */
  branches: Choice[];
  people: Choice[];
  showingRetired: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [dueOnly, setDueOnly] = useState(false);

  const needle = query.trim().toLowerCase();
  const shown = assets.filter((asset) => {
    if (dueOnly && asset.serviceState === 'OK') return false;
    if (!needle) return true;
    return [
      asset.name,
      asset.make,
      asset.model,
      asset.plate,
      asset.assignedName,
      asset.locationName,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });
  const dueCount = assets.filter((asset) => asset.serviceState !== 'OK').length;

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, plate, driver or branch"
          className={`${FIELD} min-w-56 flex-1`}
          aria-label="Search the fleet"
        />
        <button
          type="button"
          onClick={() => setDueOnly(!dueOnly)}
          aria-pressed={dueOnly}
          className={`rounded-full border px-3 py-1.5 text-xs ${
            dueOnly
              ? 'border-[var(--color-bad)] bg-[var(--color-bad)] text-[var(--color-canvas)]'
              : 'border-[var(--color-line)] text-[var(--color-muted)]'
          }`}
        >
          Service due{dueCount > 0 ? ` (${dueCount})` : ''}
        </button>
        {branches.length > 0 && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-lg bg-[var(--color-ink)] px-3 py-2 text-sm font-medium text-[var(--color-canvas)]"
          >
            Add vehicle or equipment
          </button>
        )}
      </div>

      {adding && (
        <NewAssetForm branches={branches} people={people} onDone={() => setAdding(false)} />
      )}

      {assets.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
          No vehicles or equipment yet.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
          {shown.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">
              Nothing matches.
            </li>
          )}
          {shown.map((asset) => (
            <li
              key={asset.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <Link
                  href={`/fleet/${asset.id}`}
                  className="text-sm font-medium underline-offset-4 hover:underline"
                >
                  {asset.name}
                </Link>
                {asset.status !== 'ACTIVE' && (
                  <span className="ml-2 text-xs text-[var(--color-muted)]">
                    {STATUS_LABEL[asset.status]}
                  </span>
                )}
                <p className="text-xs text-[var(--color-muted)]">
                  {[
                    KIND_LABEL[asset.kind],
                    [asset.year, asset.make, asset.model].filter(Boolean).join(' '),
                    asset.plate,
                    asset.locationName,
                    asset.assignedName && `driven by ${asset.assignedName}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {asset.meter !== 'NONE' && (
                  <span className="font-mono text-sm">
                    {formatReading(asset.reading, asset.meter)}
                  </span>
                )}
                {asset.serviceState !== 'OK' && (
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${STATE_CLASS[asset.serviceState]}`}
                  >
                    {STATE_LABEL[asset.serviceState]}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs">
        <Link
          href={showingRetired ? '/fleet' : '/fleet?retired=1'}
          className="text-[var(--color-muted)] underline underline-offset-4"
        >
          {showingRetired ? 'Hide retired' : 'Show retired'}
        </Link>
      </p>
    </>
  );
}
