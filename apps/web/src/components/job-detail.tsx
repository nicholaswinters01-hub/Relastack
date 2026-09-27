'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  type Job,
  type JobStatus,
  type MemberGroup,
  type OrganizationMember,
  formatAccountNumber,
  wallTimeToInstant,
} from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';
import { CrewPicker } from '@/components/crew-picker';

const STATUS_LABEL: Record<JobStatus, string> = {
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'On site',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
};

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

/** In the branch's own zone: the crew reads the time where the job is. */
function when(job: Job): string {
  const timeZone = job.locationTimezone ?? undefined;
  const day = new Date(job.startsAt).toLocaleDateString('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time(job.startsAt)} – ${time(job.endsAt)}`;
}

interface Props {
  job: Job;
  members: OrganizationMember[];
  groups: MemberGroup[];
  canWrite: boolean;
  /** On the crew: may move the status whatever their role. */
  onCrew: boolean;
}

/**
 * One job, on a page of its own, so it can open in its own window.
 *
 * Rescheduling stays on the schedule, where the day's other jobs are in view.
 * This page is for reading a job and changing what it is and who is on it.
 */
export function JobDetail({ job, members, groups, canWrite, onCrew }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Record<string, unknown> | null>(null);
  const [rescheduling, setRescheduling] = useState(false);

  async function send(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await apiWrite(`/api/v1/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        setConflict(null);
        router.refresh();
        return true;
      }
      const payload = await response.json().catch(() => ({}));
      // Clashes warn, never block: offer to save anyway.
      if (response.status === 409 && payload.code === 'SCHEDULE_CONFLICT') {
        setConflict(body);
        setError(payload.message ?? 'Someone on this crew is booked elsewhere at this time.');
        return false;
      }
      setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
      return false;
    } catch {
      setError('Could not reach the server.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ok = await send({
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      assigneeMembershipIds: form.getAll('crew').map(String),
    });
    if (ok) setEditing(false);
  }

  const address = [job.addressLine1, job.addressLine2, job.city, job.region, job.postalCode]
    .filter(Boolean)
    .join(', ');

  return (
    <div className="mt-6 flex flex-col gap-6">
      <dl className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 text-sm sm:grid-cols-2">
        <Fact label="When" value={when(job)} />
        <div>
          <dt className="text-xs text-[var(--color-muted)]">Status</dt>
          <dd className="mt-1">
            {canWrite || onCrew ? (
              <select
                value={job.status}
                disabled={busy}
                onChange={(event) => void send({ status: event.target.value })}
                className={FIELD}
                aria-label="Status"
              >
                {(Object.keys(STATUS_LABEL) as JobStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
            ) : (
              STATUS_LABEL[job.status]
            )}
          </dd>
        </div>
        <Fact label="Location" value={job.locationName ?? 'No location'} />
        <div>
          <dt className="text-xs text-[var(--color-muted)]">Customer</dt>
          <dd className="mt-1">
            {job.customerId && job.customerName ? (
              <Link href={`/customers/${job.customerId}`} className="underline underline-offset-4">
                {job.customerName}
                {job.customerAccountNumber !== null &&
                  ` ${formatAccountNumber(job.customerAccountNumber)}`}
              </Link>
            ) : (
              '—'
            )}
          </dd>
        </div>
        {address && <Fact label="Address" value={address} />}
        <Fact
          label="Crew"
          value={job.assignees.map((assignee) => assignee.name).join(', ') || 'Nobody yet'}
        />
        {job.description && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-[var(--color-muted)]">Notes</dt>
            <dd className="mt-1 whitespace-pre-wrap">{job.description}</dd>
          </div>
        )}
      </dl>

      {error && (
        <div className="rounded-lg bg-[var(--color-surface)] p-3 text-sm text-[var(--color-bad)]">
          <p>{error}</p>
          {conflict && (
            <button
              type="button"
              onClick={async () => {
                if (await send({ ...conflict, acknowledgeConflicts: true })) {
                  setRescheduling(false);
                  setEditing(false);
                }
              }}
              className="mt-2 text-xs underline underline-offset-4"
            >
              Save anyway
            </button>
          )}
        </div>
      )}

      {canWrite &&
        (editing ? (
          <form
            onSubmit={save}
            className="flex flex-col gap-3 rounded-xl border border-[var(--color-line)] p-5"
          >
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Title</span>
              <input
                name="title"
                defaultValue={job.title}
                required
                maxLength={200}
                className={FIELD}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Notes</span>
              <textarea
                name="description"
                defaultValue={job.description ?? ''}
                rows={3}
                maxLength={5000}
                className={FIELD}
              />
            </label>
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="font-medium">Crew</legend>
              <CrewPicker
                members={members}
                groups={groups}
                name="crew"
                selected={job.assignees.map((assignee) => assignee.membershipId)}
              />
            </fieldset>
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="text-sm underline underline-offset-4"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : rescheduling ? (
          <RescheduleForm
            job={job}
            busy={busy}
            onSubmit={async (times) => {
              if (await send(times)) setRescheduling(false);
            }}
            onCancel={() => setRescheduling(false)}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setRescheduling(true)}
              className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)]"
            >
              Reschedule
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm"
            >
              Edit job
            </button>
          </div>
        ))}
    </div>
  );
}

/** "2026-09-28" and "09:00", as the branch reads the moment. */
function wallClock(iso: string, timeZone: string): { day: string; time: string } {
  const at = new Date(iso);
  return {
    day: new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at),
    time: new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at),
  };
}

const toMinutes = (value: string) => {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
};

/**
 * Moving a job to another day or time.
 *
 * Times are typed as the branch reads them and converted with the branch's
 * zone, by the same helper the booking form and the server use, so all three
 * agree across a clock change. A clash with the crew's other work warns and
 * offers "Save anyway", as booking does. The crew is told the job moved.
 */
function RescheduleForm({
  job,
  busy,
  onSubmit,
  onCancel,
}: {
  job: Job;
  busy: boolean;
  onSubmit: (times: { startsAt: string; endsAt: string }) => void;
  onCancel: () => void;
}) {
  const zone = job.locationTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const start = wallClock(job.startsAt, zone);
  const end = wallClock(job.endsAt, zone);
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const day = String(form.get('day') ?? '');
    const from = String(form.get('from') ?? '');
    const to = String(form.get('to') ?? '');

    if (toMinutes(to) <= toMinutes(from)) {
      setProblem('The job has to end after it starts.');
      return;
    }
    setProblem(null);
    onSubmit({
      startsAt: wallTimeToInstant(day, toMinutes(from), zone).toISOString(),
      endsAt: wallTimeToInstant(day, toMinutes(to), zone).toISOString(),
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-xl border border-[var(--color-line)] p-5"
    >
      <p className="text-sm font-medium">Move this job</p>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-[var(--color-muted)]">Day</span>
          <input type="date" name="day" defaultValue={start.day} required className={FIELD} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-[var(--color-muted)]">From</span>
          <input type="time" name="from" defaultValue={start.time} required className={FIELD} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-[var(--color-muted)]">To</span>
          <input type="time" name="to" defaultValue={end.time} required className={FIELD} />
        </label>
      </div>
      <p className="text-xs text-[var(--color-muted)]">
        Times at {job.locationName ?? 'the job'} ({zone}). Everyone on the crew is told it moved.
      </p>
      {problem && <p className="text-sm text-[var(--color-bad)]">{problem}</p>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? 'Moving…' : 'Move job'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm underline underline-offset-4">
          Cancel
        </button>
      </div>
    </form>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className="mt-1">{value}</dd>
    </div>
  );
}
