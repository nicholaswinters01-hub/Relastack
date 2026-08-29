import { redirect } from 'next/navigation';
import { PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { TasksManager } from '@/components/tasks-manager';
import { getCurrentOrganization, getLocations, getOrganizationMembers, getTasks } from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{ filter?: string }>;
}

export default async function TasksPage({ searchParams }: Props) {
  const organization = await getCurrentOrganization();

  if (!organization) redirect('/login');

  const { filter = '' } = await searchParams;

  /*
   * "Open" is the default rather than everything.
   *
   * Completed work accumulates forever, and a list that opens on five hundred
   * finished items is a list nobody scrolls. "Everything" is one click away
   * for when someone genuinely wants the history.
   */
  const query =
    filter === 'mine'
      ? { mine: 'true', openOnly: 'true' }
      : filter === 'overdue'
        ? { overdue: 'true' }
        : filter === 'all'
          ? {}
          : { openOnly: 'true' };

  const canWrite = canAnywhere(organization.permissions, PERMISSIONS.TASK_WRITE);

  const [{ tasks }, locations, members] = await Promise.all([
    getTasks(query),
    getLocations(),
    canWrite ? getOrganizationMembers() : Promise.resolve([]),
  ]);

  return (
    <>
      <AppNav current="tasks" />
      <main className="mx-auto max-w-4xl px-6 py-16">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Phase 8 — Tasks
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Tasks</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          Work that needs doing, on its own or against a customer. Anything assigned to you shows up
          here wherever it sits.
        </p>

        <TasksManager
          tasks={tasks}
          locations={locations}
          members={members}
          canWrite={canWrite}
          membershipId={organization.membershipId}
          activeFilter={filter}
        />
      </main>
    </>
  );
}
