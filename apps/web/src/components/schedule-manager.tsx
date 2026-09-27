'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  wallTimeToInstant,
  type Customer,
  type Job,
  type JobConflict,
  type JobStatus,
  type Location,
  type OrganizationMember,
} from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

interface Props {
  jobs: Job[];
  locations: Location[];
  members: OrganizationMember[];
  customers: Customer[];
  canWrite: boolean;
  membershipId: string;
  day: string;
  view: 'day' | 'week';
  activeFilter: string;
}

const STATUS_LABEL: Record<JobStatus, string> = {
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'On site',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
};

const memberName = (member: OrganizationMember) =>
  [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Which calendar day a job falls on, IN THE BRANCH'S OWN ZONE.
 *
 * Not the UTC day. A 7pm visit in New York is already tomorrow in UTC, and
 * bucketing by UTC would file it under a day the crew never works.
 */
function localDay(iso: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone ?? browserZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** Minutes past local midnight, for positioning on the hour grid. */
function localMinutes(iso: string, timeZone: string | null): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone ?? browserZone(),
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);

  return hour * 60 + minute;
}

const clock = (minutes: number): string => {
  const hour = Math.floor(minutes / 60);
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  const rest = minutes % 60;

  return rest === 0
    ? `${display}${suffix}`
    : `${display}:${String(rest).padStart(2, '0')}${suffix}`;
};

const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
};

/** The Monday of the week a day falls in. */
const weekStart = (day: string): string => {
  const date = new Date(`${day}T12:00:00Z`);
  const shift = (date.getUTCDay() + 6) % 7;

  return addDays(day, -shift);
};

const PIXELS_PER_HOUR = 56;

/**
 * The schedule.
 *
 * Two views, because a service business needs both: an hour grid for a day of
 * appointments, and a week at a glance for planning further out. Jumping to a
 * date months away is a date field rather than a stack of arrow clicks.
 */
export function ScheduleManager({
  jobs,
  locations,
  members,
  customers,
  canWrite,
  membershipId,
  day,
  view,
  activeFilter,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();

  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<JobConflict[] | null>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);

  function navigate(next: Record<string, string | null>) {
    const query = new URLSearchParams(params.toString());

    for (const [key, value] of Object.entries(next)) {
      if (value === null) query.delete(key);
      else query.set(key, value);
    }

    router.push(`/schedule?${query.toString()}`);
  }

  const days = useMemo(
    () =>
      view === 'week'
        ? Array.from({ length: 7 }, (_, index) => addDays(weekStart(day), index))
        : [day],
    [day, view],
  );

  /** Jobs bucketed into the branch-local day they actually fall on. */
  const byDay = useMemo(() => {
    const map = new Map<string, Job[]>();

    for (const target of days) map.set(target, []);

    for (const job of jobs) {
      const bucket = map.get(localDay(job.startsAt, job.locationTimezone));
      if (bucket) bucket.push(job);
    }

    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          localMinutes(a.startsAt, a.locationTimezone) -
          localMinutes(b.startsAt, b.locationTimezone),
      );
    }

    return map;
  }, [jobs, days]);

  async function send(path: string, method: string, body: unknown, key: string) {
    setBusy(key);
    setError(null);

    try {
      const response = await apiWrite(path, {
        method,
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      const payload = await response.json().catch(() => ({}));

      if (response.status === 409 && payload.code === 'SCHEDULE_CONFLICT') {
        setConflicts(payload.conflicts);
        setPending(body as Record<string, unknown>);
        return false;
      }

      if (!response.ok) {
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return false;
      }

      setConflicts(null);
      setPending(null);
      router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function create(form: FormData) {
    // The DATE comes from the form, not from whichever day happens to be on
    // screen. Inheriting it from the view is how a job ends up on a date
    // nobody chose.
    const onDate = String(form.get('date') ?? '');
    const start = String(form.get('start') ?? '');
    const end = String(form.get('end') ?? '');
    const locationId = String(form.get('locationId') ?? '');
    const customerId = String(form.get('customerId') ?? '');
    const assignees = form.getAll('assignees').map(String).filter(Boolean);

    // Times are typed as the BRANCH reads them, so they are converted using
    // that branch's zone rather than the browser's. Same helper the server
    // uses for recurring visits, so both agree across a clock change.
    const zone = locations.find((l) => l.id === locationId)?.timezone ?? browserZone();
    const toMinutes = (value: string) => {
      const [hour, minute] = value.split(':').map(Number);

      return (hour ?? 0) * 60 + (minute ?? 0);
    };

    const ok = await send(
      '/api/v1/jobs',
      'POST',
      {
        title: String(form.get('title') ?? ''),
        startsAt: wallTimeToInstant(onDate, toMinutes(start), zone).toISOString(),
        endsAt: wallTimeToInstant(onDate, toMinutes(end), zone).toISOString(),
        locationId: locationId === '' ? null : locationId,
        customerId: customerId === '' ? null : customerId,
        addressLine1: String(form.get('addressLine1') ?? '') || undefined,
        city: String(form.get('city') ?? '') || undefined,
        assigneeMembershipIds: assignees,
      },
      'new',
    );

    if (ok) {
      setCreating(false);
      // Land on the day it was actually booked for, rather than leaving
      // someone staring at a day that did not change.
      if (onDate !== day) navigate({ day: onDate });
    }
  }

  const today = new Date().toLocaleDateString('en-CA');

  return (
    <div className="mt-8 flex flex-col gap-5">
      {/* ---------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => navigate({ day: addDays(day, view === 'week' ? -7 : -1) })}
          className={NAV}
        >
          ←
        </button>

        {/* A real date field: months out is one click, not thirty. */}
        <input
          type="date"
          value={day}
          onChange={(event) => event.target.value && navigate({ day: event.target.value })}
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
        />

        <button
          onClick={() => navigate({ day: addDays(day, view === 'week' ? 7 : 1) })}
          className={NAV}
        >
          →
        </button>

        <button onClick={() => navigate({ day: today })} className={NAV}>
          Today
        </button>

        <div className="ml-1 flex overflow-hidden rounded-lg border border-[var(--color-line)]">
          {(['day', 'week'] as const).map((option) => (
            <button
              key={option}
              onClick={() => navigate({ view: option === 'day' ? null : option })}
              className={`px-3 py-1.5 text-xs capitalize ${
                view === option ? 'bg-[var(--color-ink)] text-[var(--color-canvas)]' : ''
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <button
          onClick={() => navigate({ filter: activeFilter === 'mine' ? null : 'mine' })}
          className={`rounded-full border px-3 py-1 text-xs ${
            activeFilter === 'mine'
              ? 'border-transparent bg-[var(--color-ink)] text-[var(--color-canvas)]'
              : 'border-[var(--color-line)]'
          }`}
        >
          Just mine
        </button>

        {canWrite && (
          <button
            onClick={() => {
              setCreating((value) => !value);
              setConflicts(null);
            }}
            className="ml-auto rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)]"
          >
            {creating ? 'Cancel' : 'Book a job'}
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-[var(--color-surface)] p-3 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {conflicts && (
        <div className="rounded-xl border border-[var(--color-bad)] bg-[var(--color-surface)] p-5">
          <h3 className="font-semibold text-[var(--color-bad)]">Already booked</h3>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-[var(--color-muted)]">
            {conflicts.map((conflict) => (
              <li key={`${conflict.membershipId}-${conflict.jobId}`}>
                <strong>{conflict.name}</strong> — {conflict.jobTitle},{' '}
                {new Date(conflict.startsAt).toLocaleString()}
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              disabled={busy !== null}
              onClick={() =>
                pending &&
                send('/api/v1/jobs', 'POST', { ...pending, acknowledgeConflicts: true }, 'force')
              }
              className="rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
            >
              {busy === 'force' ? '…' : 'Book anyway'}
            </button>
            <button onClick={() => setConflicts(null)} className={NAV}>
              Pick another time
            </button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {creating && (
        <form
          action={create}
          className="flex flex-col gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
        >
          <input name="title" required placeholder="What is the job?" className={FIELD} />

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date">
              <input type="date" name="date" required defaultValue={day} className={FIELD} />
            </Field>
            <Field label="Starts">
              <input
                type="time"
                name="start"
                required
                defaultValue="09:00"
                step={900}
                className={FIELD}
              />
            </Field>
            <Field label="Ends">
              <input
                type="time"
                name="end"
                required
                defaultValue="11:00"
                step={900}
                className={FIELD}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Branch">
              <select name="locationId" className={FIELD} defaultValue={locations[0]?.id ?? ''}>
                <option value="">Company-wide</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Customer">
              <select name="customerId" className={FIELD}>
                <option value="">None — internal work</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.displayName}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Address">
              <input name="addressLine1" placeholder="Where the work happens" className={FIELD} />
            </Field>
            <Field label="Town">
              <input name="city" className={FIELD} />
            </Field>
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm text-[var(--color-muted)]">Who is going</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {members.map((member) => (
                <label key={member.membershipId} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="assignees" value={member.membershipId} />
                  {memberName(member)}
                </label>
              ))}
            </div>
          </fieldset>

          <button
            type="submit"
            disabled={busy !== null}
            className="self-start rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
          >
            {busy === 'new' ? '…' : 'Book it'}
          </button>
        </form>
      )}

      {/* ---------------------------------------------------------------- */}
      {view === 'week' ? (
        <WeekView
          days={days}
          byDay={byDay}
          onPickDay={(picked) => navigate({ day: picked, view: null })}
        />
      ) : (
        <DayGrid
          jobs={byDay.get(day) ?? []}
          membershipId={membershipId}
          canWrite={canWrite}
          busy={busy}
          onStatus={(id, status) => send(`/api/v1/jobs/${id}`, 'PATCH', { status }, id)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */

/**
 * A day laid out by the hour.
 *
 * Appointments are a shape, not a list: a service business needs to see the
 * gap between 10 and 2 at a glance rather than working it out from timestamps.
 */
function DayGrid({
  jobs,
  membershipId,
  canWrite,
  busy,
  onStatus,
}: {
  jobs: Job[];
  membershipId: string;
  canWrite: boolean;
  busy: string | null;
  onStatus: (id: string, status: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--color-line)] p-10 text-center text-sm text-[var(--color-muted)]">
        Nothing booked for this day.
      </p>
    );
  }

  // A working day by default, stretched to cover anything booked outside it.
  const starts = jobs.map((job) => localMinutes(job.startsAt, job.locationTimezone));
  const ends = jobs.map((job) => localMinutes(job.endsAt, job.locationTimezone));

  const firstHour = Math.min(7, Math.floor(Math.min(...starts) / 60));
  const lastHour = Math.max(19, Math.ceil(Math.max(...ends) / 60));
  const hours = Array.from({ length: lastHour - firstHour }, (_, index) => firstHour + index);

  // Overlapping jobs share the width rather than hiding behind each other.
  const columns: Job[][] = [];
  for (const job of jobs) {
    const start = localMinutes(job.startsAt, job.locationTimezone);
    const column = columns.find((entries) => {
      const last = entries[entries.length - 1]!;

      return localMinutes(last.endsAt, last.locationTimezone) <= start;
    });

    if (column) column.push(job);
    else columns.push([job]);
  }

  const columnOf = (job: Job) => columns.findIndex((entries) => entries.includes(job));

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="relative flex min-w-[34rem]">
        <div className="w-16 flex-none border-r border-[var(--color-line)]">
          {hours.map((hour) => (
            <div
              key={hour}
              style={{ height: PIXELS_PER_HOUR }}
              className="pr-2 pt-1 text-right font-mono text-xs text-[var(--color-muted)]"
            >
              {clock(hour * 60)}
            </div>
          ))}
        </div>

        <div className="relative flex-1">
          {hours.map((hour) => (
            <div
              key={hour}
              style={{ height: PIXELS_PER_HOUR }}
              className="border-b border-[var(--color-line)] last:border-b-0"
            />
          ))}

          {jobs.map((job) => {
            const start = localMinutes(job.startsAt, job.locationTimezone);
            const end = localMinutes(job.endsAt, job.locationTimezone);
            const column = columnOf(job);
            const onIt = job.assignees.some((a) => a.membershipId === membershipId);
            const closed = job.status !== 'SCHEDULED' && job.status !== 'IN_PROGRESS';

            return (
              <div
                key={job.id}
                style={{
                  top: ((start - firstHour * 60) / 60) * PIXELS_PER_HOUR,
                  height: Math.max(24, ((end - start) / 60) * PIXELS_PER_HOUR - 3),
                  left: `${(column / columns.length) * 100}%`,
                  width: `calc(${100 / columns.length}% - 6px)`,
                }}
                className={`absolute ml-1 overflow-hidden rounded-lg border px-2 py-1 text-xs ${
                  closed
                    ? 'border-[var(--color-line)] bg-[var(--color-canvas)] text-[var(--color-muted)]'
                    : 'border-[var(--color-ink)] bg-[var(--color-surface)]'
                }`}
              >
                <Link
                  href={`/jobs/${job.id}`}
                  className="block truncate font-semibold underline-offset-4 hover:underline"
                >
                  {job.title}
                </Link>
                <p className="truncate font-mono text-[11px] text-[var(--color-muted)]">
                  {clock(start)}–{clock(end)}
                </p>
                <p className="truncate text-[11px] text-[var(--color-muted)]">
                  {job.assignees.map((a) => a.name).join(', ') || 'Unassigned'}
                  {job.customerName && ` · ${job.customerName}`}
                </p>

                {(canWrite || onIt) && (
                  <select
                    value={job.status}
                    disabled={busy !== null}
                    onChange={(event) => onStatus(job.id, event.target.value)}
                    className="mt-1 w-full rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-1 py-0.5 text-[11px]"
                  >
                    {(Object.keys(STATUS_LABEL) as JobStatus[]).map((status) => (
                      <option key={status} value={status}>
                        {STATUS_LABEL[status]}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

function WeekView({
  days,
  byDay,
  onPickDay,
}: {
  days: string[];
  byDay: Map<string, Job[]>;
  onPickDay: (day: string) => void;
}) {
  const today = new Date().toLocaleDateString('en-CA');

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[48rem] grid-cols-7 gap-px rounded-xl border border-[var(--color-line)] bg-[var(--color-line)]">
        {days.map((target) => {
          const jobs = byDay.get(target) ?? [];

          return (
            <button
              key={target}
              onClick={() => onPickDay(target)}
              className={`flex min-h-40 flex-col gap-1 p-2 text-left ${
                target === today ? 'bg-[var(--color-canvas)]' : 'bg-[var(--color-surface)]'
              }`}
            >
              <span className="font-mono text-xs text-[var(--color-muted)]">
                {new Date(`${target}T12:00:00Z`).toLocaleDateString('en-US', {
                  weekday: 'short',
                  day: 'numeric',
                  timeZone: 'UTC',
                })}
              </span>

              {jobs.length === 0 ? (
                <span className="text-xs text-[var(--color-line)]">—</span>
              ) : (
                jobs.slice(0, 4).map((job) => (
                  <span
                    key={job.id}
                    className="truncate rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[11px]"
                  >
                    <span className="font-mono text-[var(--color-muted)]">
                      {clock(localMinutes(job.startsAt, job.locationTimezone))}
                    </span>{' '}
                    {job.title}
                  </span>
                ))
              )}

              {jobs.length > 4 && (
                <span className="text-[11px] text-[var(--color-muted)]">
                  +{jobs.length - 4} more
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

const NAV = 'rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm';
const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}
