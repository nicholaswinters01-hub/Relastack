'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { INVENTORY_UNITS, type InventoryItem, type StockPlace } from '@platform/shared';
import { formatQuantity } from '@/lib/inventory-format';
import { apiWrite } from '@/lib/live-sync';
import { StockChangeForm } from './stock-change-form';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

async function send(path: string, method: string, body: unknown): Promise<string | null> {
  try {
    const response = await apiWrite(path, {
      method,
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

const numberOrNull = (text: string) => {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : NaN;
};

function NewItemForm({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('each');
  const [sku, setSku] = useState('');
  const [category, setCategory] = useState('');
  const [low, setLow] = useState('');
  const [cost, setCost] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const lowStockLevel = numberOrNull(low);
    const costDollars = numberOrNull(cost);
    if (Number.isNaN(lowStockLevel) || Number.isNaN(costDollars)) {
      setError('Low-stock level and cost must be numbers.');
      return;
    }

    setBusy(true);
    const failure = await send('/api/v1/inventory/items', 'POST', {
      name,
      unit,
      sku,
      category,
      lowStockLevel,
      costCents: costDollars === null ? null : Math.round(costDollars * 100),
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    router.refresh();
    onDone();
  }

  return (
    <form
      onSubmit={submit}
      className="mt-4 flex flex-col gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
    >
      <h2 className="text-sm font-semibold">New item</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)] sm:col-span-2">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={FIELD}
            required
            maxLength={120}
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          Unit
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            list="inventory-units"
            className={FIELD}
            required
            maxLength={20}
          />
          <datalist id="inventory-units">
            {INVENTORY_UNITS.map((entry) => (
              <option key={entry} value={entry} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          SKU (optional)
          <input
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            className={FIELD}
            maxLength={60}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          Category (optional)
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={FIELD}
            maxLength={60}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          Low-stock level (optional)
          <input
            value={low}
            onChange={(e) => setLow(e.target.value)}
            inputMode="decimal"
            className={FIELD}
            placeholder="e.g. 5"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          Cost per unit, $ (optional)
          <input
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            inputMode="decimal"
            className={FIELD}
          />
        </label>
      </div>
      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add item'}
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

function PlaceSettings({ places }: { places: StockPlace[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const managed = places.filter((place) => place.canManage);
  if (managed.length === 0) return null;

  async function toggle(place: StockPlace) {
    setError(null);
    const failure = await send(`/api/v1/inventory/places/${place.id}`, 'PATCH', {
      employeesCanTake: !place.employeesCanTake,
    });
    if (failure) setError(failure);
    else router.refresh();
  }

  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
        Who can take stock
      </h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Managers can always record stock. Each branch and vehicle decides whether its employees may
        also record using and moving it themselves, and a vehicle's usual driver always can.
        Receiving and counting stay with managers.
      </p>
      <ul className="mt-3 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
        {managed.map((place) => (
          <li key={place.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="text-sm">
              {place.name}
              {place.inactive && (
                <span className="ml-2 text-xs text-[var(--color-muted)]">(inactive)</span>
              )}
            </span>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={place.employeesCanTake}
                onChange={() => void toggle(place)}
              />
              Employees can take stock
            </label>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-[var(--color-bad)]">{error}</p>}
    </section>
  );
}

/**
 * The item list: what is on hand where, what is running low, and a quick way
 * to record a change without leaving the page.
 *
 * Totals are over the places the reader can see. The API never sends more,
 * so a branch manager's "on hand" is their branches' stock and says so.
 */
export function InventoryManager({
  items,
  places,
  canConfigure,
  showingArchived,
  initialPlaceId,
}: {
  items: InventoryItem[];
  places: StockPlace[];
  canConfigure: boolean;
  showingArchived: boolean;
  /** From a link such as "Stock on Van 3". */
  initialPlaceId?: string;
}) {
  const [placeId, setPlaceId] = useState<string>(initialPlaceId ?? 'all');
  const [query, setQuery] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);

  const quantityAt = (item: InventoryItem) =>
    placeId === 'all'
      ? { onHand: item.onHand, low: item.low }
      : (item.places.find((entry) => entry.placeId === placeId) ?? { onHand: 0, low: false });

  const needle = query.trim().toLowerCase();
  const shown = items.filter((item) => {
    if (needle) {
      const haystack = [item.name, item.sku, item.category].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return !lowOnly || quantityAt(item).low;
  });
  const lowCount = items.filter((item) => item.low).length;
  const chosen = places.find((place) => place.id === placeId);
  const scopeLabel = chosen
    ? chosen.name
    : places.length === 1
      ? places[0]!.name
      : 'the places you can see';

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search items, SKU or category"
          className={`${FIELD} min-w-56 flex-1`}
          aria-label="Search items"
        />
        {places.length > 1 && (
          <select
            value={placeId}
            onChange={(e) => setPlaceId(e.target.value)}
            className={FIELD}
            aria-label="Place"
          >
            <option value="all">All places you can see</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => setLowOnly(!lowOnly)}
          aria-pressed={lowOnly}
          className={`rounded-full border px-3 py-1.5 text-xs ${
            lowOnly
              ? 'border-[var(--color-bad)] bg-[var(--color-bad)] text-[var(--color-canvas)]'
              : 'border-[var(--color-line)] text-[var(--color-muted)]'
          }`}
        >
          Low stock{lowCount > 0 ? ` (${lowCount})` : ''}
        </button>
        {canConfigure && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-lg bg-[var(--color-ink)] px-3 py-2 text-sm font-medium text-[var(--color-canvas)]"
          >
            New item
          </button>
        )}
      </div>

      {adding && <NewItemForm onDone={() => setAdding(false)} />}

      <p className="mt-3 text-xs text-[var(--color-muted)]">On hand at {scopeLabel}.</p>

      {items.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
          {canConfigure
            ? 'No items yet. Add the products and supplies you keep in stock.'
            : 'No items yet. An owner or admin adds the items the business keeps.'}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
          {shown.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">
              Nothing matches.
            </li>
          )}
          {shown.map((item) => {
            const { onHand, low } = quantityAt(item);
            return (
              <li key={item.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/inventory/${item.id}`}
                      className="text-sm font-medium underline-offset-4 hover:underline"
                    >
                      {item.name}
                    </Link>
                    {item.archived && (
                      <span className="ml-2 text-xs text-[var(--color-muted)]">archived</span>
                    )}
                    <p className="text-xs text-[var(--color-muted)]">
                      {[item.sku && `SKU ${item.sku}`, item.category].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`font-mono text-sm ${onHand < 0 ? 'text-[var(--color-bad)]' : ''}`}
                    >
                      {formatQuantity(onHand)} {item.unit}
                    </span>
                    {low && (
                      <span className="rounded-full border border-[var(--color-bad)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--color-bad)]">
                        low
                      </span>
                    )}
                    {!item.archived && (
                      <button
                        type="button"
                        onClick={() => setRecording(recording === item.id ? null : item.id)}
                        className="text-xs underline underline-offset-4"
                      >
                        {recording === item.id ? 'Close' : 'Record'}
                      </button>
                    )}
                  </div>
                </div>
                {recording === item.id && (
                  <div className="mt-3 rounded-lg border border-[var(--color-line)] p-4">
                    <StockChangeForm
                      item={item}
                      places={places}
                      initialPlaceId={placeId === 'all' ? undefined : placeId}
                      onDone={() => setRecording(null)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-xs">
        <Link
          href={showingArchived ? '/inventory' : '/inventory?archived=1'}
          className="text-[var(--color-muted)] underline underline-offset-4"
        >
          {showingArchived ? 'Hide archived items' : 'Show archived items'}
        </Link>
      </p>

      <PlaceSettings places={places} />
    </>
  );
}
