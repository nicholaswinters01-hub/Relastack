'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  METER_UNIT,
  type FleetAsset,
  type FleetAssetStatus,
  type FleetReminder,
  type FleetServiceRecord,
} from '@platform/shared';
import { STATE_CLASS, STATE_LABEL, formatDay, formatReading } from '@/lib/fleet-format';
import { apiWrite } from '@/lib/live-sync';
import type { Choice } from './fleet-manager';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';
const LABEL = 'flex flex-col gap-1 text-xs text-[var(--color-muted)]';
const PRIMARY =
  'rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50';

type Result = { ok: true } | { ok: false; status: number; payload: Record<string, unknown> };

async function send(path: string, method: string, body?: unknown): Promise<Result> {
  try {
    const response = await apiWrite(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (response.ok) return { ok: true };
    return { ok: false, status: response.status, payload: await response.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, payload: { message: 'Could not reach the server.' } };
  }
}

const messageOf = (result: Result) =>
  result.ok
    ? null
    : ((result.payload.errors as Array<{ message: string }> | undefined)?.[0]?.message ??
      (result.payload.message as string | undefined) ??
      'That did not work.');

const numberOrNull = (text: string) => (text.trim() === '' ? null : Number(text));

// ---------------------------------------------------------------------------

export function AssetEditor({
  asset,
  branches,
  people,
}: {
  asset: FleetAsset;
  branches: Choice[];
  people: Choice[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(asset.name);
  const [locationId, setLocationId] = useState(asset.locationId);
  const [status, setStatus] = useState<FleetAssetStatus>(asset.status);
  const [driver, setDriver] = useState(asset.assignedMembershipId ?? '');
  const [make, setMake] = useState(asset.make ?? '');
  const [model, setModel] = useState(asset.model ?? '');
  const [year, setYear] = useState(asset.year?.toString() ?? '');
  const [plate, setPlate] = useState(asset.plate ?? '');
  const [identifier, setIdentifier] = useState(asset.identifier ?? '');
  const [notes, setNotes] = useState(asset.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The current branch is always offered, even where the reader cannot add.
  const branchChoices = branches.some((branch) => branch.id === asset.locationId)
    ? branches
    : [{ id: asset.locationId, name: asset.locationName }, ...branches];
  const driverChoices =
    asset.assignedMembershipId && !people.some((p) => p.id === asset.assignedMembershipId)
      ? [
          { id: asset.assignedMembershipId, name: asset.assignedName ?? 'Current driver' },
          ...people,
        ]
      : people;

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const yearValue = numberOrNull(year);
    if (Number.isNaN(yearValue)) {
      setError('Year must be a number.');
      return;
    }
    setBusy(true);
    const result = await send(`/api/v1/fleet/assets/${asset.id}`, 'PATCH', {
      name,
      locationId,
      status,
      assignedMembershipId: driver || null,
      make,
      model,
      year: yearValue,
      plate,
      identifier,
      notes,
    });
    setBusy(false);
    if (!result.ok) {
      setError(messageOf(result));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm underline underline-offset-4"
      >
        Edit details
      </button>
    );
  }

  return (
    <form
      onSubmit={save}
      className="mt-4 grid w-full gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 sm:grid-cols-3"
    >
      <label className={`${LABEL} sm:col-span-2`}>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={FIELD}
          required
          maxLength={60}
        />
      </label>
      <label className={LABEL}>
        Status
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as FleetAssetStatus)}
          className={FIELD}
        >
          <option value="ACTIVE">In service</option>
          <option value="IN_SHOP">In the shop</option>
          <option value="RETIRED">Retired</option>
        </select>
      </label>
      <label className={LABEL}>
        Home branch
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          className={FIELD}
        >
          {branchChoices.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        Usual driver or user
        <select value={driver} onChange={(e) => setDriver(e.target.value)} className={FIELD}>
          <option value="">Nobody in particular</option>
          {driverChoices.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        Year
        <input
          value={year}
          onChange={(e) => setYear(e.target.value)}
          inputMode="numeric"
          className={FIELD}
        />
      </label>
      <label className={LABEL}>
        Make
        <input value={make} onChange={(e) => setMake(e.target.value)} className={FIELD} />
      </label>
      <label className={LABEL}>
        Model
        <input value={model} onChange={(e) => setModel(e.target.value)} className={FIELD} />
      </label>
      <label className={LABEL}>
        Plate
        <input value={plate} onChange={(e) => setPlate(e.target.value)} className={FIELD} />
      </label>
      <label className={`${LABEL} sm:col-span-3`}>
        {asset.kind === 'EQUIPMENT' ? 'Serial number' : 'VIN'}
        <input
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          className={FIELD}
        />
      </label>
      <label className={`${LABEL} sm:col-span-3`}>
        Notes
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className={FIELD}
          rows={3}
          maxLength={1000}
        />
      </label>
      {status === 'RETIRED' && asset.status !== 'RETIRED' && (
        <p className="text-xs text-[var(--color-muted)] sm:col-span-3">
          Retiring keeps its history and stock records, and frees the name for a new one.
        </p>
      )}
      {error && <p className="text-sm text-[var(--color-bad)] sm:col-span-3">{error}</p>}
      <div className="flex gap-2 sm:col-span-3">
        <button type="submit" disabled={busy} className={PRIMARY}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 text-sm underline underline-offset-4"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

/** Log what the meter says. A lower reading warns and can be saved anyway. */
export function ReadingForm({ asset }: { asset: FleetAsset }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(acknowledgeLower: boolean) {
    setError(null);
    const reading = Number(value);
    if (value.trim() === '' || Number.isNaN(reading)) {
      setError('Enter the reading.');
      return;
    }
    setBusy(true);
    const result = await send(`/api/v1/fleet/assets/${asset.id}/readings`, 'POST', {
      value: reading,
      acknowledgeLower,
    });
    setBusy(false);
    if (!result.ok && result.status === 409 && result.payload.code === 'READING_LOWER') {
      setWarning(result.payload.message as string);
      return;
    }
    if (!result.ok) {
      setError(messageOf(result));
      return;
    }
    setWarning(null);
    setValue('');
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void post(false);
      }}
      className="mt-3 flex flex-wrap items-end gap-2"
    >
      <label className={LABEL}>
        New reading ({METER_UNIT[asset.meter]})
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setWarning(null);
          }}
          inputMode="decimal"
          className={`${FIELD} w-40`}
        />
      </label>
      <button type="submit" disabled={busy} className={PRIMARY}>
        {busy ? 'Saving…' : 'Log it'}
      </button>
      {warning && (
        <div className="w-full rounded-lg border border-[var(--color-bad)] p-3 text-sm">
          <p>{warning}</p>
          <button
            type="button"
            onClick={() => void post(true)}
            className="mt-2 rounded-lg border border-[var(--color-bad)] px-3 py-1.5 text-xs font-medium text-[var(--color-bad)]"
          >
            Record it anyway
          </button>
        </div>
      )}
      {error && <p className="w-full text-sm text-[var(--color-bad)]">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------

function dueText(reminder: FleetReminder, meter: FleetAsset['meter']): string {
  const parts = [
    reminder.nextDueOn && formatDay(reminder.nextDueOn),
    reminder.nextDueReading !== null && formatReading(reminder.nextDueReading, meter),
  ].filter(Boolean);
  const every = [
    reminder.intervalMonths &&
      `${reminder.intervalMonths} month${reminder.intervalMonths === 1 ? '' : 's'}`,
    reminder.intervalReading !== null && formatReading(reminder.intervalReading, meter),
  ].filter(Boolean);
  return `Due ${parts.join(' or ')}${every.length ? ` · every ${every.join(' or ')}` : ' · once'}`;
}

function ServiceForm({
  asset,
  reminder,
  onDone,
}: {
  asset: FleetAsset;
  reminder: FleetReminder | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(reminder?.title ?? '');
  const [doneOn, setDoneOn] = useState('');
  const [reading, setReading] = useState(asset.reading?.toString() ?? '');
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const readingValue = asset.meter === 'NONE' ? null : numberOrNull(reading);
    const costValue = numberOrNull(cost);
    if (Number.isNaN(readingValue) || Number.isNaN(costValue)) {
      setError('Reading and cost must be numbers.');
      return;
    }
    setBusy(true);
    const result = await send(`/api/v1/fleet/assets/${asset.id}/services`, 'POST', {
      reminderId: reminder?.id ?? null,
      title: title || undefined,
      doneOn: doneOn || undefined,
      reading: readingValue,
      costCents: costValue === null ? null : Math.round(costValue * 100),
      note,
    });
    setBusy(false);
    if (!result.ok) {
      setError(messageOf(result));
      return;
    }
    router.refresh();
    onDone();
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 grid gap-3 rounded-lg border border-[var(--color-line)] p-4 sm:grid-cols-4"
    >
      <label className={`${LABEL} sm:col-span-2`}>
        What was done
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={FIELD}
          required
          maxLength={80}
        />
      </label>
      <label className={LABEL}>
        Done on (blank for today)
        <input
          type="date"
          value={doneOn}
          onChange={(e) => setDoneOn(e.target.value)}
          className={FIELD}
        />
      </label>
      {asset.meter !== 'NONE' && (
        <label className={LABEL}>
          Reading ({METER_UNIT[asset.meter]})
          <input
            value={reading}
            onChange={(e) => setReading(e.target.value)}
            inputMode="decimal"
            className={FIELD}
          />
        </label>
      )}
      <label className={LABEL}>
        Cost, $ (optional)
        <input
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          inputMode="decimal"
          className={FIELD}
        />
      </label>
      <label className={`${LABEL} sm:col-span-3`}>
        Note (optional)
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={FIELD}
          maxLength={500}
        />
      </label>
      {error && <p className="text-sm text-[var(--color-bad)] sm:col-span-4">{error}</p>}
      <div className="flex gap-2 sm:col-span-4">
        <button type="submit" disabled={busy} className={PRIMARY}>
          {busy ? 'Saving…' : 'Record service'}
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

function ReminderForm({ asset, onDone }: { asset: FleetAsset; onDone: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [months, setMonths] = useState('');
  const [distance, setDistance] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const intervalMonths = numberOrNull(months);
    const intervalReading = asset.meter === 'NONE' ? null : numberOrNull(distance);
    if (Number.isNaN(intervalMonths) || Number.isNaN(intervalReading)) {
      setError('Intervals must be numbers.');
      return;
    }
    setBusy(true);
    const result = await send(`/api/v1/fleet/assets/${asset.id}/reminders`, 'POST', {
      title,
      intervalMonths,
      intervalReading,
      nextDueOn: date || null,
    });
    setBusy(false);
    if (!result.ok) {
      setError(messageOf(result));
      return;
    }
    router.refresh();
    onDone();
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 grid gap-3 rounded-lg border border-[var(--color-line)] p-4 sm:grid-cols-4"
    >
      <label className={`${LABEL} sm:col-span-4`}>
        What is due
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={FIELD}
          required
          maxLength={80}
          placeholder="Oil change, registration, sprayer calibration…"
        />
      </label>
      <label className={LABEL}>
        Every how many months
        <input
          value={months}
          onChange={(e) => setMonths(e.target.value)}
          inputMode="numeric"
          className={FIELD}
        />
      </label>
      {asset.meter !== 'NONE' && (
        <label className={LABEL}>
          Every how many {asset.meter === 'MILES' ? 'miles' : 'hours'}
          <input
            value={distance}
            onChange={(e) => setDistance(e.target.value)}
            inputMode="decimal"
            className={FIELD}
          />
        </label>
      )}
      <label className={`${LABEL} sm:col-span-2`}>
        Next due on (optional; defaults to one interval from today)
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={FIELD}
        />
      </label>
      <p className="text-xs text-[var(--color-muted)] sm:col-span-4">
        Give months, a distance, or both, whichever comes first. A date alone is a one-off, like a
        registration renewal.
      </p>
      {error && <p className="text-sm text-[var(--color-bad)] sm:col-span-4">{error}</p>}
      <div className="flex gap-2 sm:col-span-4">
        <button type="submit" disabled={busy} className={PRIMARY}>
          {busy ? 'Saving…' : 'Add reminder'}
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

/** What is due, with "mark done" for managers, and adding reminders. */
export function RemindersPanel({ asset }: { asset: FleetAsset }) {
  const router = useRouter();
  const [completing, setCompleting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(reminder: FleetReminder) {
    setError(null);
    const result = await send(`/api/v1/fleet/reminders/${reminder.id}`, 'DELETE');
    if (!result.ok) setError(messageOf(result));
    else router.refresh();
  }

  return (
    <div>
      {asset.reminders.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">No service reminders.</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
          {asset.reminders.map((reminder) => (
            <li key={reminder.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{reminder.title}</p>
                  <p className="text-xs text-[var(--color-muted)]">
                    {dueText(reminder, asset.meter)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${STATE_CLASS[reminder.state]}`}
                  >
                    {STATE_LABEL[reminder.state]}
                  </span>
                  {asset.canManage && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setCompleting(completing === reminder.id ? null : reminder.id)
                        }
                        className="text-xs underline underline-offset-4"
                      >
                        Mark done
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(reminder)}
                        className="text-xs text-[var(--color-muted)] underline underline-offset-4"
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </div>
              {completing === reminder.id && (
                <ServiceForm asset={asset} reminder={reminder} onDone={() => setCompleting(null)} />
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-sm text-[var(--color-bad)]">{error}</p>}
      {asset.canManage && (
        <div className="mt-3 flex gap-4 text-sm">
          {!adding && completing !== 'other' && (
            <>
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="underline underline-offset-4"
              >
                Add a reminder
              </button>
              <button
                type="button"
                onClick={() => setCompleting('other')}
                className="underline underline-offset-4"
              >
                Record other service
              </button>
            </>
          )}
        </div>
      )}
      {adding && <ReminderForm asset={asset} onDone={() => setAdding(false)} />}
      {completing === 'other' && (
        <ServiceForm asset={asset} reminder={null} onDone={() => setCompleting(null)} />
      )}
    </div>
  );
}

/** Service that was done. Managers may remove a record entered by mistake. */
export function ServiceHistory({
  asset,
  services,
}: {
  asset: FleetAsset;
  services: FleetServiceRecord[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function remove(service: FleetServiceRecord) {
    if (!window.confirm(`Remove "${service.title}" on ${formatDay(service.doneOn)}?`)) return;
    setError(null);
    const result = await send(`/api/v1/fleet/services/${service.id}`, 'DELETE');
    if (!result.ok) setError(messageOf(result));
    else router.refresh();
  }

  if (services.length === 0) {
    return <p className="mt-2 text-sm text-[var(--color-muted)]">No service recorded yet.</p>;
  }

  return (
    <>
      <ul className="mt-3 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
        {services.map((service) => (
          <li
            key={service.id}
            className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3"
          >
            <div>
              <p className="text-sm font-medium">{service.title}</p>
              <p className="text-xs text-[var(--color-muted)]">
                {[
                  formatDay(service.doneOn),
                  service.reading !== null && formatReading(service.reading, asset.meter),
                  service.recordedByName,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {service.note && <p className="mt-1 text-sm">{service.note}</p>}
            </div>
            <div className="flex items-center gap-3">
              {service.costCents !== null && (
                <span className="font-mono text-sm">${(service.costCents / 100).toFixed(2)}</span>
              )}
              {asset.canManage && (
                <button
                  type="button"
                  onClick={() => void remove(service)}
                  className="text-xs text-[var(--color-muted)] underline underline-offset-4"
                >
                  Remove
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-[var(--color-bad)]">{error}</p>}
    </>
  );
}
