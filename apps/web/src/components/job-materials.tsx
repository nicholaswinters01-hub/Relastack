'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  MODULES,
  PEST_AREA_SUGGESTIONS,
  PEST_METHOD_SUGGESTIONS,
  PEST_TARGET_SUGGESTIONS,
  pestTreatmentRecordSchema,
  type InventoryItem,
  type JobMaterial,
  type StockPlace,
} from '@platform/shared';
import { formatQuantity } from '@/lib/inventory-format';
import { apiWrite } from '@/lib/live-sync';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';
const LABEL = 'flex flex-col gap-1 text-xs text-[var(--color-muted)]';

interface Person {
  id: string;
  name: string;
}

async function post(path: string, body: unknown) {
  try {
    const response = await apiWrite(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return {
      ok: response.ok,
      status: response.status,
      payload: await response.json().catch(() => ({})),
    };
  } catch {
    return { ok: false, status: 0, payload: { message: 'Could not reach the server.' } };
  }
}

const messageOf = (payload: { errors?: Array<{ message: string }>; message?: string }) =>
  payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.';

/** Choose from common answers, or type another. */
function ChoiceList({
  label,
  suggestions,
  value,
  onChange,
}: {
  label: string;
  suggestions: readonly string[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [other, setOther] = useState('');
  const toggle = (entry: string) =>
    onChange(value.includes(entry) ? value.filter((v) => v !== entry) : [...value, entry]);
  const extras = value.filter((entry) => !suggestions.includes(entry));

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-xs text-[var(--color-muted)]">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {[...suggestions, ...extras].map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={value.includes(entry)}
            onClick={() => toggle(entry)}
            className={`rounded-full border px-2.5 py-1 text-xs ${
              value.includes(entry)
                ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
                : 'border-[var(--color-line)] text-[var(--color-muted)]'
            }`}
          >
            {entry}
          </button>
        ))}
        <input
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && other.trim()) {
              e.preventDefault();
              if (!value.includes(other.trim())) onChange([...value, other.trim()]);
              setOther('');
            }
          }}
          placeholder="Other, then Enter"
          aria-label={`${label}: other`}
          className="w-36 rounded-full border border-[var(--color-line)] bg-[var(--color-canvas)] px-2.5 py-1 text-xs"
        />
      </div>
    </fieldset>
  );
}

function RecordForm({
  jobId,
  items,
  places,
  defaultPlaceId,
  pestOn,
  people,
  me,
  onDone,
}: {
  jobId: string;
  items: InventoryItem[];
  places: StockPlace[];
  defaultPlaceId: string | null;
  pestOn: boolean;
  people: Person[];
  me: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [itemId, setItemId] = useState(items[0]?.id ?? '');
  const [quantity, setQuantity] = useState('');
  const [placeId, setPlaceId] = useState(defaultPlaceId ?? places[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [method, setMethod] = useState('');
  const [mixRate, setMixRate] = useState('');
  const [wind, setWind] = useState('');
  const [temperature, setTemperature] = useState('');
  const [applicator, setApplicator] = useState(me);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const item = items.find((entry) => entry.id === itemId);
  // The job's own place, and any other the reader may take stock from.
  const choosable = places;

  async function send(acknowledgeNegative: boolean) {
    setError(null);
    const amount = Number(quantity);
    const windMph = wind.trim() === '' ? null : Number(wind);
    const temperatureF = temperature.trim() === '' ? null : Number(temperature);
    if (quantity.trim() === '' || Number.isNaN(amount)) {
      setError('Enter how much was used.');
      return;
    }
    if (Number.isNaN(windMph) || Number.isNaN(temperatureF)) {
      setError('Wind and temperature must be numbers.');
      return;
    }

    setBusy(true);
    const result = await post(`/api/v1/inventory/jobs/${jobId}/materials`, {
      itemId,
      quantity: amount,
      ...(placeId && placeId !== defaultPlaceId ? { placeId } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(pestOn
        ? {
            packFields: {
              [MODULES.PEST_CONTROL]: {
                targetPests: targets,
                areas,
                method,
                mixRate,
                windMph,
                temperatureF,
                applicatorMembershipId: applicator === me ? null : applicator,
              },
            },
          }
        : {}),
      acknowledgeNegative,
    });
    setBusy(false);

    if (!result.ok && result.status === 409 && result.payload.code === 'STOCK_BELOW_ZERO') {
      setWarning(result.payload.message);
      return;
    }
    if (!result.ok) {
      setError(messageOf(result.payload));
      return;
    }
    router.refresh();
    onDone();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(false);
  }

  return (
    <form
      onSubmit={submit}
      className="mt-4 flex flex-col gap-4 rounded-lg border border-[var(--color-line)] p-4"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={`${LABEL} sm:col-span-2`}>
          Product
          <select value={itemId} onChange={(e) => setItemId(e.target.value)} className={FIELD}>
            {items.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Amount used{item ? ` (${item.unit})` : ''}
          <input
            value={quantity}
            onChange={(e) => {
              setQuantity(e.target.value);
              setWarning(null);
            }}
            inputMode="decimal"
            className={FIELD}
            required
          />
        </label>
        {choosable.length > 0 && (
          <label className={LABEL}>
            Taken from
            <select value={placeId} onChange={(e) => setPlaceId(e.target.value)} className={FIELD}>
              {choosable.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                  {place.id === defaultPlaceId ? ' (this job)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {pestOn && (
          <>
            <label className={LABEL}>
              Mix rate (optional)
              <input
                value={mixRate}
                onChange={(e) => setMixRate(e.target.value)}
                placeholder="0.8 fl oz per gallon"
                className={FIELD}
                maxLength={60}
              />
            </label>
            <label className={LABEL}>
              Applied by
              <select
                value={applicator}
                onChange={(e) => setApplicator(e.target.value)}
                className={FIELD}
              >
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>

      {pestOn && (
        <>
          <ChoiceList
            label="Target pests"
            suggestions={PEST_TARGET_SUGGESTIONS}
            value={targets}
            onChange={setTargets}
          />
          <ChoiceList
            label="Areas treated"
            suggestions={PEST_AREA_SUGGESTIONS}
            value={areas}
            onChange={setAreas}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={LABEL}>
              Method
              <input
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                list="pest-methods"
                className={FIELD}
                required
                maxLength={40}
              />
              <datalist id="pest-methods">
                {PEST_METHOD_SUGGESTIONS.map((entry) => (
                  <option key={entry} value={entry} />
                ))}
              </datalist>
            </label>
            <label className={LABEL}>
              Wind, mph (outdoors)
              <input
                value={wind}
                onChange={(e) => setWind(e.target.value)}
                inputMode="decimal"
                className={FIELD}
              />
            </label>
            <label className={LABEL}>
              Temperature, °F (outdoors)
              <input
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                inputMode="decimal"
                className={FIELD}
              />
            </label>
          </div>
        </>
      )}

      <label className={LABEL}>
        Note (optional)
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={FIELD}
          maxLength={500}
        />
      </label>

      {warning && (
        <div className="rounded-lg border border-[var(--color-bad)] p-3 text-sm">
          <p>{warning}</p>
          <button
            type="button"
            onClick={() => void send(true)}
            className="mt-2 rounded-lg border border-[var(--color-bad)] px-3 py-1.5 text-xs font-medium text-[var(--color-bad)]"
          >
            Record anyway
          </button>
        </div>
      )}
      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !itemId}
          className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? 'Saving…' : pestOn ? 'Record treatment' : 'Record'}
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

function Line({ line, canRecord }: { line: JobMaterial; canRecord: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const parsed = pestTreatmentRecordSchema.safeParse(line.packFields[MODULES.PEST_CONTROL]);
  const pest = parsed.success ? parsed.data : null;

  async function voidLine() {
    const reason = window.prompt('Why is this line wrong? It stays on the record, marked void.');
    if (!reason?.trim()) return;
    const result = await post(`/api/v1/inventory/materials/${line.id}/void`, {
      reason: reason.trim(),
    });
    if (!result.ok) setError(messageOf(result.payload));
    else router.refresh();
  }

  return (
    <li className={`px-4 py-3 ${line.voided ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-sm font-medium ${line.voided ? 'line-through' : ''}`}>
            {line.itemName}
            {pest?.epaRegistrationNumber && (
              <span className="ml-2 font-mono text-xs font-normal text-[var(--color-muted)]">
                EPA {pest.epaRegistrationNumber}
              </span>
            )}
          </p>
          {pest && (
            <p className="text-xs text-[var(--color-muted)]">
              {[
                pest.targetPests.join(', '),
                pest.areas.join(', '),
                pest.method,
                pest.mixRate,
                pest.windMph != null && `wind ${pest.windMph} mph`,
                pest.temperatureF != null && `${pest.temperatureF}°F`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <p className="text-xs text-[var(--color-muted)]">
            {pest
              ? `Applied by ${pest.applicatorName}${pest.applicatorLicense ? ` (license ${pest.applicatorLicense})` : ' (no license on file)'}`
              : `Recorded by ${line.recordedByName}`}{' '}
            · from {line.placeName}
          </p>
          {line.note && <p className="mt-1 text-sm">{line.note}</p>}
          {line.voided && (
            <p className="mt-1 text-xs text-[var(--color-bad)]">
              Voided by {line.voided.byName}: {line.voided.reason}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm">
            {formatQuantity(line.quantity)} {line.unit}
          </span>
          {canRecord && !line.voided && (
            <button
              type="button"
              onClick={() => void voidLine()}
              className="text-xs text-[var(--color-muted)] underline underline-offset-4"
            >
              Void
            </button>
          )}
        </div>
      </div>
      {error && <p className="mt-1 text-sm text-[var(--color-bad)]">{error}</p>}
    </li>
  );
}

/**
 * What was used on a job. With the Pest Control pack, each line is an
 * application record: what, how much, on what pest, where, how, and by whom.
 * Lines are voided with a reason, never edited or removed.
 */
export function JobMaterials({
  jobId,
  materials,
  canRecord,
  defaultPlaceId,
  items,
  places,
  pestOn,
  people,
  me,
}: {
  jobId: string;
  materials: JobMaterial[];
  canRecord: boolean;
  defaultPlaceId: string | null;
  items: InventoryItem[];
  places: StockPlace[];
  pestOn: boolean;
  people: Person[];
  me: string;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <section className="mt-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{pestOn ? 'Treatments' : 'Materials used'}</h2>
        {pestOn && materials.length > 0 && (
          <a href={`/jobs/${jobId}/record`} className="text-sm underline underline-offset-4">
            Print application record
          </a>
        )}
      </div>
      {materials.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">Nothing recorded yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
          {materials.map((line) => (
            <Line key={line.id} line={line} canRecord={canRecord} />
          ))}
        </ul>
      )}
      {canRecord &&
        (items.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--color-muted)]">
            Add your products under Inventory to record what was used.
          </p>
        ) : adding ? (
          <RecordForm
            jobId={jobId}
            items={items}
            places={places}
            defaultPlaceId={defaultPlaceId}
            pestOn={pestOn}
            people={people}
            me={me}
            onDone={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-3 rounded-lg bg-[var(--color-ink)] px-3 py-2 text-sm font-medium text-[var(--color-canvas)]"
          >
            {pestOn ? 'Record a treatment' : 'Record materials used'}
          </button>
        ))}
    </section>
  );
}
