import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS, type BoardJob, type BoardPerson } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { BoardBranchPicker } from '@/components/board-branch-picker';
import { HelpActions } from '@/components/help-call';
import { getBoard, getCurrentOrganization, getModules } from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const STATE: Record<BoardPerson['state'], { label: string; tone: string }> = {
  ON_SITE: { label: 'On site', tone: 'border-[var(--color-ok)] text-[var(--color-ok)]' },
  BETWEEN_JOBS: {
    label: 'Between jobs',
    tone: 'border-[var(--color-line)] text-[var(--color-ink)]',
  },
  DONE: { label: 'Done for the day', tone: 'border-[var(--color-line)] text-[var(--color-muted)]' },
  NOTHING_BOOKED: {
    label: 'Nothing booked',
    tone: 'border-[var(--color-line)] text-[var(--color-muted)]',
  },
};

function JobLine({ job, label }: { job: BoardJob; label: string }) {
  return (
    <p className="text-xs">
      <span className="text-[var(--color-muted)]">{label}: </span>
      <Link href={`/jobs/${job.id}`} className="underline underline-offset-4">
        {job.title}
      </Link>
      <span className="text-[var(--color-muted)]">
        {' '}
        · {time(job.startsAt)}–{time(job.endsAt)}
        {job.customerName && ` · ${job.customerName}`}
        {job.vehicleName && ` · ${job.vehicleName}`}
      </span>
      {job.late && <span className="ml-1 text-[var(--color-bad)]">late</span>}
    </p>
  );
}

/**
 * The manager's board: today at the branches you run. Who is on site and
 * where, who is between jobs, what is running late, what nobody is on, and
 * anyone in the field calling for a manager. It refreshes itself every minute
 * while it is on screen.
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ location?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const { location } = await searchParams;
  const modules = await getModules();
  const schedulingOn = modules.some((m) => m.key === MODULES.SCHEDULING && m.enabled);
  const canRun = canAnywhere(organization.permissions, PERMISSIONS.JOB_WRITE);
  const board = schedulingOn && canRun ? await getBoard({ locationId: location }) : null;

  return (
    <>
      <AppNav current="board" />
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Today</h1>
            {board && (
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                {new Date(`${board.day}T12:00:00Z`).toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  timeZone: 'UTC',
                })}
                {' · '}
                {board.counts.completed} of {board.counts.total} visits done ·{' '}
                {board.counts.inProgress} on site now
              </p>
            )}
          </div>
          {board && board.locations.length > 1 && (
            <BoardBranchPicker locations={board.locations} selected={board.locationId} />
          )}
        </div>

        {!schedulingOn ? (
          <p className="mt-4 text-[var(--color-muted)]">The board comes with Scheduling.</p>
        ) : !canRun ? (
          <p className="mt-4 text-[var(--color-muted)]">The board is for managers.</p>
        ) : !board ? (
          <p className="mt-6 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
            We could not load the board just now.
          </p>
        ) : (
          <>
            {(board.help.length > 0 || board.late.length > 0 || board.unassigned.length > 0) && (
              <section className="mt-8 rounded-xl border border-[var(--color-bad)] bg-[var(--color-surface)] p-5">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-bad)]">
                  Needs you
                </h2>
                <ul className="mt-3 flex flex-col gap-3">
                  {board.help.map((call) => (
                    <li key={call.id} className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">
                          {call.requestedByName} needs a manager
                          {call.status === 'ACKNOWLEDGED' && (
                            <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">
                              {call.acknowledgedByName} is on it
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-[var(--color-muted)]">
                          <Link
                            href={`/jobs/${call.jobId}`}
                            className="underline underline-offset-4"
                          >
                            {call.jobTitle}
                          </Link>
                          {call.locationName && ` · ${call.locationName}`} · called at{' '}
                          {time(call.createdAt)}
                          {call.note && ` · "${call.note}"`}
                        </p>
                      </div>
                      <HelpActions request={call} canClose={false} />
                    </li>
                  ))}
                  {board.late.map((job) => (
                    <li key={`late-${job.id}`}>
                      <JobLine
                        job={job}
                        label={job.status === 'SCHEDULED' ? 'Not started yet' : 'Running over'}
                      />
                      <p className="text-xs text-[var(--color-muted)]">
                        {job.crew.length > 0 ? job.crew.join(', ') : 'Nobody on it'}
                      </p>
                    </li>
                  ))}
                  {board.unassigned.map((job) => (
                    <li key={`free-${job.id}`}>
                      <JobLine job={job} label="Nobody on it" />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="mt-8">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
                People
              </h2>
              {board.people.length === 0 ? (
                <p className="mt-3 text-sm text-[var(--color-muted)]">
                  Nobody is booked at these branches today.
                </p>
              ) : (
                <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {board.people.map((person) => (
                    <li
                      key={person.membershipId}
                      className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold">{person.name}</p>
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${STATE[person.state].tone}`}
                        >
                          {STATE[person.state].label}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-col gap-1">
                        {person.current && <JobLine job={person.current} label="Now" />}
                        {person.next && <JobLine job={person.next} label="Next" />}
                        <p className="text-xs text-[var(--color-muted)]">
                          {person.jobCount === 0
                            ? 'No visits today'
                            : `${person.doneCount} of ${person.jobCount} visits done`}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
