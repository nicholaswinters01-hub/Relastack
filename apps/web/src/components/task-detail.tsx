'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Location, OrganizationMember, Task, TaskStatus } from '@platform/shared';
import { TaskEditor } from '@/components/task-editor';
import { apiWrite } from '@/lib/live-sync';

const STATUS_LABEL: Record<TaskStatus, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};

interface Props {
  task: Task;
  locations: Location[];
  members: OrganizationMember[];
  canWrite: boolean;
  canDelete: boolean;
  /** Whoever holds the task may move its status whatever their role. */
  isAssignee: boolean;
}

/** One task, on a page of its own, so it can open in its own window. */
export function TaskDetail({ task, locations, members, canWrite, canDelete, isAssignee }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await apiWrite(`/api/v1/tasks/${task.id}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.');
        return false;
      }
      if (method === 'DELETE') router.push('/tasks');
      else router.refresh();
      return true;
    } catch {
      setError('Could not reach the server.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const due = task.dueAt
    ? new Date(task.dueAt).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
    : 'No due date';

  return (
    <div className="mt-6 flex flex-col gap-6">
      <dl className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-[var(--color-muted)]">Status</dt>
          <dd className="mt-1">
            {canWrite || isAssignee ? (
              <select
                value={task.status}
                disabled={busy}
                onChange={(event) => void send('PATCH', { status: event.target.value })}
                aria-label="Status"
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm"
              >
                {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
            ) : (
              STATUS_LABEL[task.status]
            )}
          </dd>
        </div>
        <Fact label="Due" value={due} />
        <Fact label="Assigned to" value={task.assigneeName ?? 'Nobody yet'} />
        <Fact label="Location" value={task.locationName ?? 'Whole business'} />
        <div>
          <dt className="text-xs text-[var(--color-muted)]">Customer</dt>
          <dd className="mt-1">
            {task.customerId && task.customerName ? (
              <Link href={`/customers/${task.customerId}`} className="underline underline-offset-4">
                {task.customerName}
              </Link>
            ) : (
              '—'
            )}
          </dd>
        </div>
        {task.description && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-[var(--color-muted)]">Details</dt>
            <dd className="mt-1 whitespace-pre-wrap">{task.description}</dd>
          </div>
        )}
      </dl>

      {error && <p className="text-sm text-[var(--color-bad)]">{error}</p>}

      {canWrite &&
        (editing ? (
          <TaskEditor
            task={task}
            locations={locations}
            members={members}
            canDelete={canDelete}
            busy={busy}
            onSave={async (changes) => {
              const ok = await send('PATCH', changes);
              if (ok) setEditing(false);
              return ok;
            }}
            onDelete={() => send('DELETE')}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="self-start rounded-lg border border-[var(--color-line)] px-4 py-2 text-sm"
          >
            Edit task
          </button>
        ))}
    </div>
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
