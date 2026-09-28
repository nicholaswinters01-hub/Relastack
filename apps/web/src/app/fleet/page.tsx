import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { SettingsLink } from '@/components/settings-link';
import { FleetManager } from '@/components/fleet-manager';
import {
  getCurrentOrganization,
  getFleet,
  getLocations,
  getModules,
  getOrganizationMembers,
} from '@/lib/api';
import { canAnywhere, canAt } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function FleetPage({
  searchParams,
}: {
  searchParams: Promise<{ retired?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const { retired } = await searchParams;
  const showingRetired = retired === '1';
  const modules = await getModules();
  const fleet = modules.find((module) => module.key === MODULES.FLEET);
  const canRead = canAnywhere(organization.permissions, PERMISSIONS.FLEET_READ);
  const canWrite = canAnywhere(organization.permissions, PERMISSIONS.FLEET_WRITE);

  const [data, locations, members] =
    fleet?.enabled && canRead
      ? await Promise.all([
          getFleet(showingRetired),
          canWrite ? getLocations() : Promise.resolve([]),
          canWrite ? getOrganizationMembers() : Promise.resolve([]),
        ])
      : [null, [], []];

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
      <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Fleet</h1>
          <SettingsLink section="fleet" />
        </div>

        {!fleet?.enabled ? (
          <p className="mt-3 text-[var(--color-muted)]">
            {fleet?.entitled ? (
              <>
                Fleet is switched off.{' '}
                <Link href="/modules" className="underline underline-offset-4">
                  Turn it on
                </Link>
              </>
            ) : (
              <>
                Fleet comes with an industry pack.{' '}
                <Link href="/help" className="underline underline-offset-4">
                  Ask about it
                </Link>
              </>
            )}
          </p>
        ) : !canRead ? (
          <p className="mt-3 text-[var(--color-muted)]">
            Your role does not include the fleet. Ask an owner or admin.
          </p>
        ) : !data ? (
          <p className="mt-6 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
            We could not load the fleet just now.
          </p>
        ) : (
          <>
            <p className="mt-2 text-[var(--color-muted)]">
              Vehicles and equipment, what their meters say, and the service they are due.
            </p>
            <FleetManager
              assets={data.assets}
              branches={branches}
              people={people}
              showingRetired={showingRetired}
            />
          </>
        )}
      </main>
    </>
  );
}
