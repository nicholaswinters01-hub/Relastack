'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiWrite } from '@/lib/live-sync';

interface Vehicle {
  id: string;
  name: string;
}

/**
 * The vehicle a job's crew takes.
 *
 * A vehicle already out on an overlapping job comes back as a warning, and
 * "Book it anyway" sends it again acknowledged, like a crew clash.
 */
export function JobVehicle({
  jobId,
  vehicleId,
  vehicleName,
  vehicles,
  canWrite,
}: {
  jobId: string;
  vehicleId: string | null;
  vehicleName: string | null;
  vehicles: Vehicle[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState(vehicleId ?? '');
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(acknowledgeConflicts: boolean) {
    setError(null);
    setBusy(true);
    try {
      const response = await apiWrite(`/api/v1/fleet/jobs/${jobId}/vehicle`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ vehicleId: choice || null, acknowledgeConflicts }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409 && payload.code === 'VEHICLE_CONFLICT') {
        setWarning(payload.message);
        return;
      }
      if (!response.ok) {
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return;
      }
      setWarning(null);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  // Keep the current vehicle choosable even if it has since been retired.
  const options =
    vehicleId && !vehicles.some((vehicle) => vehicle.id === vehicleId)
      ? [{ id: vehicleId, name: vehicleName ?? 'Current vehicle' }, ...vehicles]
      : vehicles;

  return (
    <section className="mt-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
      <h2 className="text-sm font-semibold">Vehicle</h2>
      {!canWrite ? (
        <p className="mt-1 text-sm">
          {vehicleId ? (
            <Link href={`/fleet/${vehicleId}`} className="underline underline-offset-4">
              {vehicleName}
            </Link>
          ) : (
            <span className="text-[var(--color-muted)]">None chosen</span>
          )}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value);
              setWarning(null);
            }}
            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm"
            aria-label="Vehicle"
          >
            <option value="">No vehicle</option>
            {options.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void save(false)}
            disabled={busy || choice === (vehicleId ?? '')}
            className="rounded-lg bg-[var(--color-ink)] px-3 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          {vehicleId && (
            <Link href={`/fleet/${vehicleId}`} className="text-sm underline underline-offset-4">
              Open {vehicleName}
            </Link>
          )}
        </div>
      )}
      {warning && (
        <div className="mt-3 rounded-lg border border-[var(--color-bad)] p-3 text-sm">
          <p>{warning}</p>
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={busy}
            className="mt-2 rounded-lg border border-[var(--color-bad)] px-3 py-1.5 text-xs font-medium text-[var(--color-bad)]"
          >
            Book it anyway
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-[var(--color-bad)]">{error}</p>}
    </section>
  );
}
