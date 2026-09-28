import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { InventoryManager } from '@/components/inventory-manager';
import { getCurrentOrganization, getInventory, getModules } from '@/lib/api';
import { can, canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string; place?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const { archived, place } = await searchParams;
  const showingArchived = archived === '1';
  const modules = await getModules();
  const inventory = modules.find((module) => module.key === MODULES.INVENTORY);
  const canRead = canAnywhere(organization.permissions, PERMISSIONS.INVENTORY_READ);
  const data = inventory?.enabled && canRead ? await getInventory(showingArchived) : null;

  return (
    <>
      <AppNav current="inventory" />
      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">Inventory</h1>

        {!inventory?.enabled ? (
          <p className="mt-3 text-[var(--color-muted)]">
            {inventory?.entitled ? (
              <>
                Inventory is switched off.{' '}
                <Link href="/modules" className="underline underline-offset-4">
                  Turn it on
                </Link>
              </>
            ) : (
              <>
                Inventory is not included in your plan.{' '}
                <Link href="/plans" className="underline underline-offset-4">
                  Compare plans
                </Link>
              </>
            )}
          </p>
        ) : !canRead ? (
          <p className="mt-3 text-[var(--color-muted)]">
            Your role does not include inventory. Ask an owner or admin.
          </p>
        ) : !data ? (
          <p className="mt-6 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
            We could not load inventory just now.
          </p>
        ) : (
          <>
            <p className="mt-2 text-[var(--color-muted)]">
              What you keep in stock, where it is, and every change to it.
            </p>
            <InventoryManager
              items={data.items}
              places={data.places}
              canConfigure={can(organization.permissions, PERMISSIONS.INVENTORY_CONFIGURE)}
              showingArchived={showingArchived}
              pestOn={modules.some((m) => m.key === MODULES.PEST_CONTROL && m.enabled)}
              initialPlaceId={data.places.some((entry) => entry.id === place) ? place : undefined}
            />
          </>
        )}
      </main>
    </>
  );
}
