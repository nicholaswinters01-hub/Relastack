'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { INVENTORY_UNITS, type InventoryItem } from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

async function patch(id: string, body: unknown): Promise<string | null> {
  try {
    const response = await apiWrite(`/api/v1/inventory/items/${id}`, {
      method: 'PATCH',
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

/**
 * Edit an item's details, or archive it. For owners and admins: the item list
 * is the whole company's. Archiving keeps the history and frees the name.
 */
export function InventoryItemEditor({ item }: { item: InventoryItem }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(item.name);
  const [unit, setUnit] = useState(item.unit);
  const [sku, setSku] = useState(item.sku ?? '');
  const [category, setCategory] = useState(item.category ?? '');
  const [low, setLow] = useState(item.lowStockLevel?.toString() ?? '');
  const [cost, setCost] = useState(
    item.costCents === null ? '' : (item.costCents / 100).toFixed(2),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const lowStockLevel = low.trim() === '' ? null : Number(low);
    const costDollars = cost.trim() === '' ? null : Number(cost);
    if (Number.isNaN(lowStockLevel) || Number.isNaN(costDollars)) {
      setError('Low-stock level and cost must be numbers.');
      return;
    }

    setBusy(true);
    const failure = await patch(item.id, {
      name,
      unit,
      sku,
      category,
      lowStockLevel,
      costCents: costDollars === null ? null : Math.round(costDollars * 100),
    });
    setBusy(false);
    if (failure) setError(failure);
    else {
      setOpen(false);
      router.refresh();
    }
  }

  async function archive(archived: boolean) {
    setError(null);
    setBusy(true);
    const failure = await patch(item.id, { archived });
    setBusy(false);
    if (failure) setError(failure);
    else router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-3 text-sm">
        {!item.archived && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="underline underline-offset-4"
          >
            {open ? 'Close' : 'Edit item'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void archive(!item.archived)}
          disabled={busy}
          className="text-[var(--color-muted)] underline underline-offset-4"
        >
          {item.archived ? 'Bring back' : 'Archive'}
        </button>
      </div>
      {error && !open && <p className="text-sm text-[var(--color-bad)]">{error}</p>}

      {open && (
        <form
          onSubmit={save}
          className="mt-2 grid w-full gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 sm:grid-cols-3"
        >
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)] sm:col-span-2">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={FIELD}
              required
              maxLength={120}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Unit
            <input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              list="inventory-units-edit"
              className={FIELD}
              required
              maxLength={20}
            />
            <datalist id="inventory-units-edit">
              {INVENTORY_UNITS.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            SKU
            <input value={sku} onChange={(e) => setSku(e.target.value)} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Category
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Low-stock level
            <input
              value={low}
              onChange={(e) => setLow(e.target.value)}
              inputMode="decimal"
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            Cost per unit, $
            <input
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              inputMode="decimal"
              className={FIELD}
            />
          </label>
          {error && <p className="text-sm text-[var(--color-bad)] sm:col-span-3">{error}</p>}
          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
