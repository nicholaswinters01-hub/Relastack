import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { TaskDetail } from '@/components/task-detail';
import { getCurrentOrganization, getLocations, getOrganizationMembers, getTask } from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const { id } = await params;
  // The API decides visibility; a task this person may not see is simply not found.
  const task = await getTask(id);
  if (!task) notFound();

  const canWrite = canAnywhere(organization.permissions, PERMISSIONS.TASK_WRITE);
  const canDelete = canAnywhere(organization.permissions, PERMISSIONS.TASK_DELETE);
  const [locations, members] = await Promise.all([
    canWrite ? getLocations() : Promise.resolve([]),
    canWrite ? getOrganizationMembers() : Promise.resolve([]),
  ]);

  return (
    <>
      <AppNav current="tasks" />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href="/tasks"
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          Tasks
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{task.title}</h1>
        <TaskDetail
          task={task}
          locations={locations}
          members={members}
          canWrite={canWrite}
          canDelete={canDelete}
          isAssignee={task.assigneeMembershipId === organization.membershipId}
        />
      </main>
    </>
  );
}
