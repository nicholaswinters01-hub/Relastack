'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  isOverdue,
  type Location,
  type OrganizationMember,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from '@platform/shared';
import { TaskEditor } from '@/components/task-editor';

interface Props {
  tasks: Task[];
  locations: Location[];
  members: OrganizationMember[];
  canWrite: boolean;
  canDelete: boolean;
  membershipId: string;
  activeFilter: string;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};

/** Ordered by how much attention each deserves, not alphabetically. */
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  URGENT: 'Urgent',
  HIGH: 'High',
  NORMAL: 'Normal',
  LOW: 'Low',
};

const FILTERS = [
  { key: '', label: 'Open' },
  { key: 'mine', label: 'Mine' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'all', label: 'Everything' },
];

/**
 * The task list.
 *
 * Note what is NOT here: any decision about which tasks exist. The server
 * scoped the query before it ran, and it also decided whether this reader may
 * know which customer each task concerns — a task at your branch can be about
 * a customer at another, and the name comes back null when it is.
 */
export function TasksManager({
  tasks,
  locations,
  members,
  canWrite,
  canDelete,
  membershipId,
  activeFilter,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function applyFilter(key: string) {
    const query = new URLSearchParams(params.toString());
    if (key === '') query.delete('filter');
    else query.set('filter', key);
    router.push(`/tasks?${query.toString()}`);
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

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return false;
      }

      router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function create(form: FormData) {
    const locationId = String(form.get('locationId') ?? '');
    const assignee = String(form.get('assigneeMembershipId') ?? '');
    const due = String(form.get('dueAt') ?? '');

    const ok = await send(
      '/api/v1/tasks',
      'POST',
      {
        title: String(form.get('title') ?? ''),
        description: String(form.get('description') ?? '') || undefined,
        priority: String(form.get('priority') ?? 'NORMAL'),
        // A date input gives a bare day; the API wants a real instant.
        dueAt: due ? new Date(`${due}T17:00:00`).toISOString() : null,
        locationId: locationId === '' ? null : locationId,
        assigneeMembershipId: assignee === '' ? null : assignee,
      },
      'new',
    );

    if (ok) setCreating(false);
  }

  return (
    <div className="mt-8 flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((filter) => (
          <button
            key={filter.key}
            onClick={() => applyFilter(filter.key)}
            className={`rounded-full border px-3 py-1 text-xs ${
              activeFilter === filter.key
                ? 'border-transparent bg-[var(--color-ink)] text-[var(--color-canvas)]'
                : 'border-[var(--color-line)]'
            }`}
          >
            {filter.label}
          </button>
        ))}

        {canWrite && (
          <button
            onClick={() => setCreating((value) => !value)}
            className="ml-auto rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)]"
          >
            {creating ? 'Cancel' : 'Add task'}
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-[var(--color-surface)] p-3 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      )}

      {creating && (
        <form
          action={create}
          className="flex flex-col gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
        >
          <input
            name="title"
            required
            placeholder="What needs doing?"
            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2"
          />
          <textarea
            name="description"
            rows={2}
            placeholder="Any detail worth keeping (optional)"
            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm"
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Priority">
              <select name="priority" defaultValue="NORMAL" className={SELECT}>
                {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Due">
              <input type="date" name="dueAt" className={SELECT} />
            </Field>

            <Field label="Location">
              <select name="locationId" className={SELECT}>
                <option value="">Company-wide</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Assign to">
              <select name="assigneeMembershipId" className={SELECT}>
                <option value="">Nobody yet</option>
                {members.map((member) => (
                  <option key={member.membershipId} value={member.membershipId}>
                    {[member.firstName, member.lastName].filter(Boolean).join(' ') || member.email}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <button
            type="submit"
            disabled={busy !== null}
            className="self-start rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
          >
            {busy === 'new' ? '…' : 'Create'}
          </button>
        </form>
      )}

      {tasks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
          Nothing here. Anything at a location you do not work at is not shown.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((task) => {
            const late = isOverdue(task);
            const closed = task.status === 'DONE' || task.status === 'CANCELLED';
            // Whoever holds the task can always move it on, whatever their role.
            const canMove = canWrite || task.assigneeMembershipId === membershipId;

            return (
              <div
                key={task.id}
                className={`flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-[var(--color-surface)] p-4 ${
                  late ? 'border-[var(--color-bad)]' : 'border-[var(--color-line)]'
                }`}
              >
                <div className="min-w-56 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className={`font-semibold ${closed ? 'text-[var(--color-muted)]' : ''}`}>
                      {task.title}
                    </h3>
                    {task.priority !== 'NORMAL' && (
                      <span className="font-mono text-xs text-[var(--color-muted)]">
                        {PRIORITY_LABEL[task.priority].toLowerCase()}
                      </span>
                    )}
                    {late && (
                      <span className="font-mono text-xs text-[var(--color-bad)]">overdue</span>
                    )}
                  </div>

                  {task.description && (
                    <p className="mt-1 text-sm text-[var(--color-muted)]">{task.description}</p>
                  )}

                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-[var(--color-muted)]">
                    <span>{task.assigneeName ?? 'Unassigned'}</span>
                    <span>{task.locationName ?? 'Company-wide'}</span>
                    {task.dueAt && <span>due {new Date(task.dueAt).toLocaleDateString()}</span>}
                    {/* Null when the reader may not see that customer. */}
                    {task.customerId && task.customerName && (
                      <Link
                        href={`/customers/${task.customerId}`}
                        className="underline underline-offset-2"
                      >
                        {task.customerName}
                      </Link>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {/*
                   * Shown only to people who can actually save. An assignee
                   * without task.write may move the status beside it, but the
                   * API refuses them everything else, so offering the form
                   * would only produce a 403 they cannot act on.
                   */}
                  {canWrite && (
                    <button
                      onClick={() => setEditing(editing === task.id ? null : task.id)}
                      className="rounded-lg border border-[var(--color-line)] px-2 py-1.5 text-xs"
                    >
                      {editing === task.id ? 'Close' : 'Edit'}
                    </button>
                  )}

                  <select
                    value={task.status}
                    disabled={!canMove || busy !== null}
                    onChange={(event) =>
                      send(
                        `/api/v1/tasks/${task.id}`,
                        'PATCH',
                        { status: event.target.value },
                        task.id,
                      )
                    }
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1.5 text-xs disabled:opacity-50"
                  >
                    {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((status) => (
                      <option key={status} value={status}>
                        {STATUS_LABEL[status]}
                      </option>
                    ))}
                  </select>
                </div>

                {canWrite && editing === task.id && (
                  <TaskEditor
                    task={task}
                    locations={locations}
                    members={members}
                    canDelete={canDelete}
                    busy={busy === task.id}
                    onSave={(changes) =>
                      send(`/api/v1/tasks/${task.id}`, 'PATCH', changes, task.id)
                    }
                    onDelete={() => send(`/api/v1/tasks/${task.id}`, 'DELETE', undefined, task.id)}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const SELECT =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}
