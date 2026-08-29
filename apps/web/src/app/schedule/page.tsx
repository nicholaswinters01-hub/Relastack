import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { ScheduleManager } from '@/components/schedule-manager';
import {
  getCurrentOrganization,
  getCustomers,
  getJobs,
  getLocations,
  getModules,
  getOrganizationMembers,
} from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{ day?: string; filter?: string }>;
}

export default async function SchedulePage({ searchParams }: Props) {
  const organization = await getCurrentOrganization();

  if (!organization) redirect('/login');

  const modules = await getModules();
  const scheduling = modules.find((module) => module.key === MODULES.SCHEDULING);

  // The API refuses these routes without the module regardless. Checking here
  // is only so the page can explain itself rather than showing an empty day.
  if (!scheduling?.enabled) {
    return (
      <>
        <AppNav current="schedule" />
        <main className="mx-auto max-w-3xl px-6 py-16">
          <h1 className="text-3xl font-semibold tracking-tight">Schedule</h1>
          <p className="mt-3 text-[var(--color-muted)]">
            {scheduling?.entitled
              ? 'Scheduling is not switched on for your organization yet.'
              : 'Scheduling is not included in your plan.'}
          </p>
          <p className="mt-6 text-sm">
            <Link
              href={scheduling?.entitled ? '/modules' : '/billing'}
              className="underline underline-offset-4"
            >
              {scheduling?.entitled ? 'Turn it on' : 'See plans'}
            </Link>
          </p>
        </main>
      </>
    );
  }

  const { day: requestedDay, filter = '' } = await searchParams;

  // Default to today. The window is a full UTC day; jobs are rendered in the
  // branch's own zone, which is the time the crew actually reads.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(requestedDay ?? '')
    ? (requestedDay as string)
    : new Date().toISOString().slice(0, 10);

  const nextDay = new Date(`${day}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);

  const canWrite = canAnywhere(organization.permissions, PERMISSIONS.JOB_WRITE);

  const [{ jobs }, locations, members, { customers }] = await Promise.all([
    getJobs({
      from: `${day}T00:00:00.000Z`,
      to: nextDay.toISOString(),
      ...(filter === 'mine' ? { mine: 'true' } : {}),
    }),
    getLocations(),
    canWrite ? getOrganizationMembers() : Promise.resolve([]),
    canWrite ? getCustomers({ stage: 'ACTIVE' }) : Promise.resolve({ customers: [] }),
  ]);

  return (
    <>
      <AppNav current="schedule" />
      <main className="mx-auto max-w-4xl px-6 py-16">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Phase 9 — Scheduling
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Schedule</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          Jobs booked into the day, with who is going. Times show in the branch&apos;s own zone.
        </p>

        <ScheduleManager
          jobs={jobs}
          locations={locations}
          members={members}
          customers={customers}
          canWrite={canWrite}
          membershipId={organization.membershipId}
          day={day}
          activeFilter={filter}
        />
      </main>
    </>
  );
}
