'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { InventoryItem, StockPlace } from '@platform/shared';
import { formatQuantity } from '@/lib/inventory-format';
import { apiWrite } from '@/lib/live-sync';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

type Action = 'receive' | 'use' | 'move' | 'count' | 'damaged' | 'correct';

const ACTIONS: Array<{ key: Action; label: string; taking: boolean }> = [
  { key: 'receive', label: 'Receive', taking: false },
  { key: 'use', label: 'Use', taking: true },
  { key: 'move', label: 'Move', taking: true },
  { key: 'count', label: 'Count', taking: false },
  { key: 'damaged', label: 'Damaged or lost', taking: false },
  { key: 'correct', label: 'Correct', taking: false },
];

/**
 * Record one change to an item's stock.
 *
 * Offers only what the reader may do at the chosen place: managing actions
 * where they manage the branch, using and moving where the branch lets
 * employees take stock. The API decides again whatever this offers.
 *
 * Taking stock below zero comes back as a warning with what is on hand, and
 * "Record anyway" sends it again acknowledged, the same way a job clash does.
 */
export function StockChangeForm({
  item,
  places,
  initialPlaceId,
  onDone,
}: {
  item: InventoryItem;
  places: StockPlace[];
  initialPlaceId?: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const usable = places.filter((place) => place.canTake || place.canManage);
  const [placeId, setPlaceId] = useState(
    usable.find((place) => place.id === initialPlaceId)?.id ??
      // Where the item already is, before any place that has never held it.
      usable.find((place) => item.places.some((entry) => entry.placeId === place.id))?.id ??
      usable[0]?.id ??
      '',
  );
  const place = usable.find((entry) => entry.id === placeId);
  const allowed = ACTIONS.filter((action) => (action.taking ? place?.canTake : place?.canManage));
  const [action, setAction] = useState<Action>(allowed[0]?.key ?? 'use');
  const [amount, setAmount] = useState('');
  const [toPlaceId, setToPlaceId] = useState('');
  const [note, setNote] = useState('');
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (usable.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        You can see this stock but not change it. A manager can let employees take stock at a
        branch.
      </p>
    );
  }

  const current = allowed.some((entry) => entry.key === action) ? action : allowed[0]?.key;
  const onHere = item.places.find((entry) => entry.placeId === placeId)?.onHand ?? 0;
  const destinations = usable.filter((entry) => entry.id !== placeId && entry.canTake);

  async function send(acknowledgeNegative: boolean) {
    setError(null);
    const value = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(value)) {
      setError('Enter an amount.');
      return;
    }

    const body: Record<string, unknown> = { action: current, itemId: item.id, placeId };
    if (current === 'count') body.counted = value;
    else if (current === 'correct') body.change = value;
    else body.quantity = value;
    if (current === 'move') body.toPlaceId = toPlaceId || destinations[0]?.id;
    if (note.trim()) body.note = note.trim();
    if (acknowledgeNegative) body.acknowledgeNegative = true;

    setBusy(true);
    try {
      const response = await apiWrite('/api/v1/inventory/changes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));

      if (response.status === 409 && payload.code === 'STOCK_BELOW_ZERO') {
        setWarning(payload.message);
        return;
      }
      if (!response.ok) {
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return;
      }

      setWarning(null);
      setAmount('');
      setNote('');
      router.refresh();
      onDone?.();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(false);
  }

  const amountLabel =
    current === 'count'
      ? `Counted (${item.unit})`
      : current === 'correct'
        ? `Change by (${item.unit}, use − to take away)`
        : `Amount (${item.unit})`;

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="What happened">
        {allowed.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="radio"
            aria-checked={current === entry.key}
            onClick={() => {
              setAction(entry.key);
              setWarning(null);
            }}
            className={`rounded-full border px-3 py-1 text-xs ${
              current === entry.key
                ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
                : 'border-[var(--color-line)] text-[var(--color-muted)]'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          {current === 'move' ? 'From' : 'Where'}
          <select
            value={placeId}
            onChange={(event) => {
              setPlaceId(event.target.value);
              setWarning(null);
            }}
            className={FIELD}
          >
            {usable.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>

        {current === 'move' && (
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            To
            <select
              value={toPlaceId || destinations[0]?.id || ''}
              onChange={(event) => setToPlaceId(event.target.value)}
              className={FIELD}
            >
              {destinations.length === 0 && <option value="">Nowhere you can move to</option>}
              {destinations.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
          {amountLabel}
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setWarning(null);
            }}
            className={`${FIELD} w-32`}
            required
          />
        </label>

        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-[var(--color-muted)]">
          Note {current === 'correct' ? '(required)' : '(optional)'}
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            className={FIELD}
            required={current === 'correct'}
            placeholder={current === 'receive' ? 'Supplier or invoice' : ''}
          />
        </label>
      </div>

      <p className="text-xs text-[var(--color-muted)]">
        On hand at {place?.name}: {formatQuantity(onHere)} {item.unit}
      </p>

      {warning && (
        <div className="rounded-lg border border-[var(--color-bad)] p-3 text-sm">
          <p>{warning}</p>
          <button
            type="button"
            onClick={() => void send(true)}
            disabled={busy}
            className="mt-2 rounded-lg border border-[var(--color-bad)] px-3 py-1.5 text-xs font-medium text-[var(--color-bad)]"
          >
            Record anyway
          </button>
        </div>
      )}
      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}

      <div>
        <button
          type="submit"
          disabled={busy || (current === 'move' && destinations.length === 0)}
          className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Record'}
        </button>
      </div>
    </form>
  );
}
