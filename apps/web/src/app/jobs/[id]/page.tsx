import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { JobDetail } from '@/components/job-detail';
import { JobVehicle } from '@/components/job-vehicle';
import {
  getCurrentOrganization,
  getFleet,
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
      </main>
    </>
  );
}
