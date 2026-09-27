import { AppNav } from '@/components/app-nav';
import { redirect } from 'next/navigation';
import { LocationsManager } from '@/components/locations-manager';
import { PERMISSIONS } from '@platform/shared';
import { getCurrentOrganization, getLocations, getOrganizationMembers } from '@/lib/api';
import { can, canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function LocationsPage() {
  const organization = await getCurrentOrganization();

  if (!organization) redirect('/login');

  // Creating a location adds a billable unit, so it needs the permission
  // organization-wide. Assigning people is scoped, so a Location Manager
  // qualifies for their own branches.
  const canCreate = can(organization.permissions, PERMISSIONS.LOCATION_WRITE);
  const canAssignSomewhere = canAnywhere(organization.permissions, PERMISSIONS.LOCATION_ASSIGN);

  const [locations, members] = await Promise.all([
    getLocations(),
    canAssignSomewhere ? getOrganizationMembers() : Promise.resolve([]),
  ]);

  const activeCount = locations.filter((location) => location.status === 'ACTIVE').length;

  return (
    <>
      <AppNav current="locations" />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {organization.organization.name}
        </h1>
        <p className="mt-3 text-[var(--color-muted)]">
          {canCreate
            ? 'Every location your business operates. This count is what the subscription will be priced on.'
            : 'The locations you can access.'}
        </p>

        {canCreate && (
          <p className="mt-4 inline-block rounded-lg bg-[var(--color-surface)] px-3 py-1.5 font-mono text-sm">
            {activeCount} active {activeCount === 1 ? 'location' : 'locations'}
          </p>
        )}

        <LocationsManager
          locations={locations}
          members={members}
          permissions={organization.permissions}
          canCreate={canCreate}
        />
      </main>
    </>
  );
}
