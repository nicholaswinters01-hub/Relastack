import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import {
  AssetEditor,
  ReadingForm,
  RemindersPanel,
  ServiceHistory,
} from '@/components/fleet-asset-panels';
import {
  getCurrentOrganization,
  getFleetAsset,
  getLocations,
  getModules,
  getOrganizationMembers,
} from '@/lib/api';
import {
  KIND_LABEL,
  STATE_CLASS,
  STATE_LABEL,
  STATUS_LABEL,
  formatDay,
  formatReading,
} from '@/lib/fleet-format';
import { canAt } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function FleetAssetPage({ params }: { params: Promise<{ id: string }> }) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const { id } = await params;
  const detail = await getFleetAsset(id);
  if (!detail) notFound();

  const { asset, readings, services } = detail;
  const [locations, members, modules] = await Promise.all([
    asset.canManage ? getLocations() : Promise.resolve([]),
    asset.canManage ? getOrganizationMembers() : Promise.resolve([]),
    getModules(),
  ]);
  const inventoryOn = modules.some((m) => m.key === MODULES.INVENTORY && m.enabled);
  const branches = locations
    .filter(
      (location) =>
        location.status === 'ACTIVE' &&
        canAt(organization.permissions, PERMISSIONS.FLEET_WRITE, location.id),
    )
    .map((location) => ({ id: location.id, name: location.name }));
  const people = members.map((member) => ({
    id: member.membershipId,
    name: [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email,
  }));

  return (
    <>
      <AppNav current="fleet" />
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <Link
          href="/fleet"
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          Fleet
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              {asset.name}
              {asset.status !== 'ACTIVE' && (
                <span className="ml-3 align-middle text-sm font-normal text-[var(--color-muted)]">
                  {STATUS_LABEL[asset.status]}
                </span>
              )}
            </h1>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {[
                KIND_LABEL[asset.kind],
                [asset.year, asset.make, asset.model].filter(Boolean).join(' '),
                asset.plate && `plate ${asset.plate}`,
                asset.identifier &&
                  `${asset.kind === 'EQUIPMENT' ? 'serial' : 'VIN'} ${asset.identifier}`,
                `kept at ${asset.locationName}`,
                asset.assignedName && `driven by ${asset.assignedName}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {asset.notes && <p className="mt-2 max-w-2xl text-sm">{asset.notes}</p>}
          </div>
          {asset.canManage && <AssetEditor asset={asset} branches={branches} people={people} />}
        </div>

        {asset.meter !== 'NONE' && (
          <section className="mt-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            <p className="text-xs text-[var(--color-muted)]">
              {asset.meter === 'MILES' ? 'Odometer' : 'Engine hours'}
              {asset.readingOn && ` · ${formatDay(asset.readingOn)}`}
            </p>
            <p className="mt-1 text-2xl font-semibold">
              {formatReading(asset.reading, asset.meter)}
            </p>
            {asset.canLogReadings && <ReadingForm asset={asset} />}
          </section>
        )}

        <section className="mt-8">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
              Service due
            </h2>
            {asset.serviceState !== 'OK' && (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${STATE_CLASS[asset.serviceState]}`}
              >
                {STATE_LABEL[asset.serviceState]}
              </span>
            )}
          </div>
          <RemindersPanel asset={asset} />
        </section>

        {asset.stockPlaceId && inventoryOn && (
          <p className="mt-8 text-sm">
            <Link
              href={`/inventory?place=${asset.stockPlaceId}`}
              className="underline underline-offset-4"
            >
              Stock on {asset.name}
            </Link>
          </p>
        )}

        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
            Service history
          </h2>
          <ServiceHistory asset={asset} services={services} />
        </section>

        {readings.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
              Readings
            </h2>
            <ul className="mt-3 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
              {readings.map((reading) => (
                <li key={reading.id} className="flex justify-between gap-3 px-4 py-2 text-sm">
                  <span>{formatReading(reading.value, asset.meter)}</span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {formatDay(reading.readOn)} · {reading.recordedByName}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
