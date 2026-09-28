import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { InventoryItemEditor } from '@/components/inventory-item-editor';
import { StockChangeForm } from '@/components/stock-change-form';
import { getCurrentOrganization, getInventoryItem } from '@/lib/api';
import { REASON_LABEL, formatQuantity } from '@/lib/inventory-format';
import { can } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export default async function InventoryItemPage({ params }: { params: Promise<{ id: string }> }) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const { id } = await params;
  const detail = await getInventoryItem(id);
  if (!detail) notFound();

  const { item, places, movements } = detail;
  const quantities = new Map(item.places.map((entry) => [entry.placeId, entry]));
  const carried = places.filter((place) => quantities.has(place.id));

  return (
    <>
      <AppNav current="inventory" />
      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <Link
          href="/inventory"
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          Inventory
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              {item.name}
              {item.archived && (
                <span className="ml-3 align-middle text-sm font-normal text-[var(--color-muted)]">
                  archived
                </span>
              )}
            </h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {[
                item.sku && `SKU ${item.sku}`,
                item.category,
                `counted in ${item.unit}`,
                item.lowStockLevel !== null &&
                  `low at ${formatQuantity(item.lowStockLevel)} ${item.unit}`,
                item.costCents !== null && `$${(item.costCents / 100).toFixed(2)} per ${item.unit}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          {can(organization.permissions, PERMISSIONS.INVENTORY_CONFIGURE) && (
            <InventoryItemEditor item={item} />
          )}
        </div>

        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
            On hand
          </h2>
          {carried.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              None recorded yet at the places you can see.
            </p>
          ) : (
            <ul className="mt-3 grid gap-3 sm:grid-cols-3">
              {carried.map((place) => {
                const entry = quantities.get(place.id)!;
                return (
                  <li
                    key={place.id}
                    className={`rounded-xl border bg-[var(--color-surface)] p-4 ${
                      entry.low ? 'border-[var(--color-bad)]' : 'border-[var(--color-line)]'
                    }`}
                  >
                    <p className="text-xs text-[var(--color-muted)]">{place.name}</p>
                    <p
                      className={`mt-1 text-2xl font-semibold ${
                        entry.onHand < 0 ? 'text-[var(--color-bad)]' : ''
                      }`}
                    >
                      {formatQuantity(entry.onHand)}{' '}
                      <span className="text-sm font-normal">{item.unit}</span>
                    </p>
                    {entry.low && <p className="text-xs text-[var(--color-bad)]">Low</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {!item.archived && (
          <section className="mt-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            <h2 className="mb-3 text-sm font-semibold">Record a change</h2>
            <StockChangeForm item={item} places={places} />
          </section>
        )}

        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
            History
          </h2>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Every change, newest first. Nothing here is ever edited; a mistake is fixed with a
            correction.
          </p>
          {movements.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--color-muted)]">Nothing recorded yet.</p>
          ) : (
            <ul className="mt-3 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
              {movements.map((movement) => (
                <li
                  key={movement.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span className="font-medium">
                        {REASON_LABEL[movement.reason] ?? movement.reason}
                      </span>{' '}
                      <span className="text-[var(--color-muted)]">at {movement.placeName}</span>
                    </p>
                    <p className="text-xs text-[var(--color-muted)]">
                      {movement.recordedByName} · {when(movement.createdAt)}
                      {movement.countedQuantity !== null &&
                        ` · counted ${formatQuantity(movement.countedQuantity)}`}
                    </p>
                    {movement.note && <p className="mt-1 text-sm">{movement.note}</p>}
                  </div>
                  <span
                    className={`font-mono text-sm ${
                      movement.quantity < 0 ? 'text-[var(--color-bad)]' : 'text-[var(--color-ok)]'
                    }`}
                  >
                    {movement.quantity > 0 ? '+' : ''}
                    {formatQuantity(movement.quantity)} {item.unit}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
