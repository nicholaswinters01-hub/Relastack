import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { JobDetail } from '@/components/job-detail';
import { getCurrentOrganization, getJob, getOrganizationMembers } from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const { id } = await params;
  // The API decides visibility; a job this person may not see is simply not found.
  const job = await getJob(id);
  if (!job) notFound();

  const canWrite = canAnywhere(organization.permissions, PERMISSIONS.JOB_WRITE);
  const members = canWrite ? await getOrganizationMembers() : [];
  const onCrew = job.assignees.some((a) => a.membershipId === organization.membershipId);

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
        <JobDetail job={job} members={members} canWrite={canWrite} onCrew={onCrew} />
      </main>
    </>
  );
}
