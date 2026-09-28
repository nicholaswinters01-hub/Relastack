import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { JobDetail } from '@/components/job-detail';
import { JobMaterials } from '@/components/job-materials';
import { JobSignoff } from '@/components/job-signoff';
import { JobVehicle } from '@/components/job-vehicle';
import {
  getCurrentOrganization,
  getCurrentUser,
  getFleet,
  getInventory,
  getJobMaterials,
  getJobSignoff,
  getGroups,
  getJob,
  getModules,
  getOrganizationMembers,
} from '@/lib/api';
import { canAnywhere, canAt } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const { id } = await params;
  // The API decides visibility; a job this person may not see is simply not found.
  const job = await getJob(id);
  if (!job) notFound();

  const canWrite = canAnywhere(organization.permissions, PERMISSIONS.JOB_WRITE);
  const [members, groups] = canWrite
    ? await Promise.all([getOrganizationMembers(), getGroups()])
    : [[], []];
  const onCrew = job.assignees.some((a) => a.membershipId === organization.membershipId);

  // Shown only where the business runs a fleet. Changing it is booking the
  // job, so it follows job.write at the job's branch, as the API does.
  const modules = await getModules();
  const fleetOn =
    modules.some((m) => m.key === MODULES.FLEET && m.enabled) &&
    canAnywhere(organization.permissions, PERMISSIONS.FLEET_READ);
  const fleet = fleetOn ? await getFleet() : null;
  const vehicles = (fleet?.assets ?? []).filter((asset) => asset.kind !== 'EQUIPMENT');
  const canSetVehicle = job.locationId
    ? canAt(organization.permissions, PERMISSIONS.JOB_WRITE, job.locationId)
    : organization.permissions.organizationWide.includes(PERMISSIONS.JOB_WRITE);

  // What was used on the job, and with the Pest Control pack, the treatments
  // and the customer's signature. The API decides who may record them.
  const enabled = (key: string) => modules.some((m) => m.key === key && m.enabled);
  const inventoryOn =
    enabled(MODULES.INVENTORY) && canAnywhere(organization.permissions, PERMISSIONS.INVENTORY_READ);
  const pestOn = enabled(MODULES.PEST_CONTROL);
  const [materials, inventory, signoff, user] = await Promise.all([
    inventoryOn ? getJobMaterials(job.id) : Promise.resolve(null),
    inventoryOn ? getInventory() : Promise.resolve(null),
    pestOn ? getJobSignoff(job.id) : Promise.resolve(null),
    getCurrentUser(),
  ]);
  const me = organization.membershipId;
  const myName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Me';
  const people = [
    { id: me, name: myName },
    ...job.assignees
      .filter((a) => a.membershipId !== me)
      .map((a) => ({ id: a.membershipId, name: a.name })),
  ];
  const takeFrom = (inventory?.places ?? []).filter(
    (place) => place.canTake || place.id === materials?.defaultPlaceId,
  );

  return (
    <>
      <AppNav current="schedule" />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href={`/schedule?day=${job.startsAt.slice(0, 10)}`}
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          Schedule
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{job.title}</h1>
        <JobDetail
          job={job}
          members={members}
          groups={groups}
          canWrite={canWrite}
          onCrew={onCrew}
        />
        {fleetOn && (
          <JobVehicle
            jobId={job.id}
            vehicleId={job.vehicleId}
            vehicleName={job.vehicleName}
            vehicles={vehicles.map((v) => ({ id: v.id, name: v.name }))}
            canWrite={canSetVehicle}
          />
        )}
        {materials && (
          <JobMaterials
            jobId={job.id}
            materials={materials.materials}
            canRecord={materials.canRecord}
            defaultPlaceId={materials.defaultPlaceId}
            items={(inventory?.items ?? []).filter((item) => !item.archived)}
            places={takeFrom}
            pestOn={pestOn}
            people={people}
            me={me}
          />
        )}
        {pestOn && (
          <JobSignoff
            jobId={job.id}
            signoff={signoff}
            canSign={onCrew || canSetVehicle}
            defaultName={job.customerName ?? ''}
          />
        )}
      </main>
    </>
  );
}
