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
  searchParams: Promise<{ day?: string; filter?: string; view?: string }>;
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

  const { day: requestedDay, filter = '', view: requestedView } = await searchParams;

  const day = /^\d{4}-\d{2}-\d{2}$/.test(requestedDay ?? '')
    ? (requestedDay as string)
    : new Date().toLocaleDateString('en-CA');

  const view = requestedView === 'week' ? 'week' : 'day';

  /*
   * Fetch a day either side of what is shown, then let the client file each
   * job under its BRANCH-local day.
   *
   * A UTC-day window is wrong for anyone not on UTC: a 7pm visit in New York
   * is already tomorrow in UTC, so it would vanish from the day the crew
   * actually works it. Over-fetching two days and bucketing properly costs
   * nothing and is correct for a company whose branches span zones.
   */
  const span = view === 'week' ? 7 : 1;
  const anchor = new Date(`${day}T00:00:00.000Z`);
  const monday = new Date(anchor);
  if (view === 'week') monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));

  const from = new Date(monday);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(monday);
  to.setUTCDate(to.getUTCDate() + span + 1);

  const canWrite = canAnywhere(organization.permissions, PERMISSIONS.JOB_WRITE);

  const [{ jobs }, locations, members, { customers }] = await Promise.all([
    getJobs({
      from: from.toISOString(),
      to: to.toISOString(),
      limit: '200',
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
          Jobs booked in, with who is going. Times show in the branch&apos;s own zone.
        </p>

        <ScheduleManager
          jobs={jobs}
          locations={locations}
          members={members}
          customers={customers}
          canWrite={canWrite}
          membershipId={organization.membershipId}
          day={day}
          view={view}
          activeFilter={filter}
        />
      </main>
    </>
  );
}
