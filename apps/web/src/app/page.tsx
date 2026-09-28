import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { DashboardView } from '@/components/dashboard-view';
import { GettingStarted } from '@/components/getting-started';
import {
  getCurrentOrganization,
  getCurrentUser,
  getDashboard,
  getFleet,
  getInventory,
  getModules,
  getSetupProgress,
} from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';

// The dashboard, replacing the Phase 0 status page this route used to hold.

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await getCurrentUser();

  if (!user) redirect('/login');

  const organization = await getCurrentOrganization();

  if (!organization) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">You are signed in</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          Your account does not belong to an organization yet.
        </p>
      </main>
    );
  }

  // The checklist is only for whoever runs the business; anyone else gets null.
  const [modules, setup] = await Promise.all([getModules(), getSetupProgress()]);
  const enabled = (key: string) => modules.some((m) => m.key === key && m.enabled);
  const checklist = setup && (
    <GettingStarted
      organizationId={organization.organization.id}
      progress={setup}
      crmOn={enabled(MODULES.CRM)}
      schedulingOn={enabled(MODULES.SCHEDULING)}
    />
  );
  const reporting = modules.find((module) => module.key === MODULES.REPORTING);

  // Not "Morning": the page is rendered on a server that does not know the
  // reader's time of day.
  const greeting = user.firstName ? `Hello, ${user.firstName}` : organization.organization.name;

  if (!reporting?.enabled) {
    return (
      <>
        <AppNav current="dashboard" />
        <main className="mx-auto max-w-screen-2xl px-6 py-16">
          <h1 className="text-3xl font-semibold tracking-tight">{greeting}</h1>
          {checklist}
          <p className="mt-3 text-[var(--color-muted)]">
            {reporting?.entitled
              ? 'Turn on Reporting to see how the business is doing at a glance.'
              : 'Reporting is not included in your plan.'}
          </p>
          <p className="mt-6 text-sm">
            <Link
              href={reporting?.entitled ? '/modules' : '/billing'}
              className="underline underline-offset-4"
            >
              {reporting?.entitled ? 'Turn it on' : 'See plans'}
            </Link>
          </p>
        </main>
      </>
    );
  }

  // From the inventory list itself, so the count passes through exactly the
  // branch filter the list does: a manager hears about their branches only.
  const inventoryOn =
    enabled(MODULES.INVENTORY) && canAnywhere(organization.permissions, PERMISSIONS.INVENTORY_READ);
  const fleetOn =
    enabled(MODULES.FLEET) && canAnywhere(organization.permissions, PERMISSIONS.FLEET_READ);
  const [dashboard, inventory, fleet] = await Promise.all([
    getDashboard(),
    inventoryOn ? getInventory() : Promise.resolve(null),
    fleetOn ? getFleet() : Promise.resolve(null),
  ]);
  const lowStock = inventory?.items.filter((item) => item.low).length ?? 0;
  const serviceDue = fleet?.assets.filter((asset) => asset.serviceState !== 'OK') ?? [];
  const overdue = serviceDue.filter((asset) => asset.serviceState === 'OVERDUE').length;

  return (
    <>
      <AppNav current="dashboard" />
      <main className="mx-auto max-w-screen-2xl px-6 py-16">
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{greeting}</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          Where {organization.organization.name} stands over the last thirty days.
        </p>

        {checklist}

        {lowStock > 0 && (
          <p className="mt-6 rounded-xl border border-[var(--color-bad)] bg-[var(--color-surface)] px-4 py-3 text-sm">
            {lowStock} item{lowStock === 1 ? '' : 's'} running low
            {inventory && inventory.places.length === 1
              ? ` at ${inventory.places[0]!.name}`
              : ''}.{' '}
            <Link href="/inventory" className="underline underline-offset-4">
              See inventory
            </Link>
          </p>
        )}

        {serviceDue.length > 0 && (
          <p className="mt-3 rounded-xl border border-[var(--color-bad)] bg-[var(--color-surface)] px-4 py-3 text-sm">
            {serviceDue.length === 1
              ? `${serviceDue[0]!.name} is due for service`
              : `${serviceDue.length} vehicles and equipment are due for service`}
            {overdue > 0 && serviceDue.length > 1 ? ` (${overdue} overdue)` : ''}.{' '}
            <Link
              href={serviceDue.length === 1 ? `/fleet/${serviceDue[0]!.id}` : '/fleet'}
              className="underline underline-offset-4"
            >
              See the fleet
            </Link>
          </p>
        )}

        {dashboard ? (
          <DashboardView dashboard={dashboard} />
        ) : (
          <p className="mt-8 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
            We could not load your figures just now.
          </p>
        )}
      </main>
    </>
  );
}
