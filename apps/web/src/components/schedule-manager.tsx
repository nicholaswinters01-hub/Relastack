'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type {
  Customer,
  Job,
  JobConflict,
  JobStatus,
  Location,
  OrganizationMember,
} from '@platform/shared';

interface Props {
  jobs: Job[];
  locations: Location[];
  members: OrganizationMember[];
  customers: Customer[];
  canWrite: boolean;
  membershipId: string;
  day: string;
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

/**
 * A day's schedule.
 *
 * Times are rendered in the BRANCH's timezone, not the viewer's. An office
 * manager checking tomorrow from a laptop set to another zone must see the
 * time the crew will actually arrive.
 */
function timeIn(iso: string, timeZone: string | null): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

export function ScheduleManager({
  jobs,
  locations,
  members,
  customers,
  canWrite,
  membershipId,
  day,
  activeFilter,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();

  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Held so the conflict can be shown and then overridden deliberately. */
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

  function shiftDay(days: number) {
    const date = new Date(`${day}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    navigate({ day: date.toISOString().slice(0, 10) });
  }

  async function send(path: string, method: string, body: unknown, key: string) {
    setBusy(key);
    setError(null);

    try {
      const response = await fetch(path, {
        method,
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      const payload = await response.json().catch(() => ({}));

      if (response.status === 409 && payload.code === 'SCHEDULE_CONFLICT') {
        // Not an error — a question. Hold the booking and show who is busy.
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
    const start = String(form.get('start') ?? '');
    const end = String(form.get('end') ?? '');
    const locationId = String(form.get('locationId') ?? '');
    const customerId = String(form.get('customerId') ?? '');
    const assignees = form.getAll('assignees').map(String).filter(Boolean);

    const ok = await send(
      '/api/v1/jobs',
      'POST',
      {
        title: String(form.get('title') ?? ''),
        // The inputs give wall-clock times on the chosen day; the API wants
        // instants.
        startsAt: new Date(`${day}T${start}`).toISOString(),
        endsAt: new Date(`${day}T${end}`).toISOString(),
        locationId: locationId === '' ? null : locationId,
        customerId: customerId === '' ? null : customerId,
        addressLine1: String(form.get('addressLine1') ?? '') || undefined,
        city: String(form.get('city') ?? '') || undefined,
        assigneeMembershipIds: assignees,
      },
      'new',
    );

    if (ok) setCreating(false);
  }

  return (
    <div className="mt-8 flex flex-col gap-6">
      {/* ---------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => shiftDay(-1)}
          className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm"
        >
          ←
        </button>
        <span className="min-w-44 text-center font-medium">
          {new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC',
          })}
        </span>
        <button
          onClick={() => shiftDay(1)}
          className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm"
        >
          →
        </button>

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
                {new Date(conflict.startsAt).toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                –
                {new Date(conflict.endsAt).toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
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
            <button
              onClick={() => setConflicts(null)}
              className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-xs"
            >
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

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Starts">
              <input type="time" name="start" required defaultValue="09:00" className={FIELD} />
            </Field>
            <Field label="Ends">
              <input type="time" name="end" required defaultValue="11:00" className={FIELD} />
            </Field>

            <Field label="Branch">
              <select name="locationId" className={FIELD}>
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
      {jobs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
          Nothing booked for this day.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {jobs.map((job) => {
            const onIt = job.assignees.some((a) => a.membershipId === membershipId);
            const canMove = canWrite || onIt;
            const closed = job.status !== 'SCHEDULED' && job.status !== 'IN_PROGRESS';

            return (
              <div
                key={job.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
              >
                <div className="min-w-56 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-sm tabular-nums">
                      {timeIn(job.startsAt, job.locationTimezone)}–
                      {timeIn(job.endsAt, job.locationTimezone)}
                    </span>
                    <h3 className={`font-semibold ${closed ? 'text-[var(--color-muted)]' : ''}`}>
                      {job.title}
                    </h3>
                  </div>

                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--color-muted)]">
                    <span>
                      {job.assignees.length > 0
                        ? job.assignees.map((a) => a.name).join(', ')
                        : 'Nobody assigned'}
                    </span>
                    <span>{job.locationName ?? 'Company-wide'}</span>
                    {[job.addressLine1, job.city].filter(Boolean).length > 0 && (
                      <span>{[job.addressLine1, job.city].filter(Boolean).join(', ')}</span>
                    )}
                    {/* Null when the reader may not see that customer. */}
                    {job.customerId && job.customerName && (
                      <Link
                        href={`/customers/${job.customerId}`}
                        className="underline underline-offset-2"
                      >
                        {job.customerName}
                      </Link>
                    )}
                  </p>
                </div>

                <select
                  value={job.status}
                  disabled={!canMove || busy !== null}
                  onChange={(event) =>
                    send(`/api/v1/jobs/${job.id}`, 'PATCH', { status: event.target.value }, job.id)
                  }
                  className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-xs disabled:opacity-50"
                >
                  {(Object.keys(STATUS_LABEL) as JobStatus[]).map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
