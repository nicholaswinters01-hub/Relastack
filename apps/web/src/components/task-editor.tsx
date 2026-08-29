'use client';

import { useState } from 'react';
import {
  type Location,
  type OrganizationMember,
  type Task,
  type TaskPriority,
} from '@platform/shared';

/** Ordered by how much attention each deserves, not alphabetically. */
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  URGENT: 'Urgent',
  HIGH: 'High',
  NORMAL: 'Normal',
  LOW: 'Low',
};

const SELECT =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

interface Props {
  task: Task;
  locations: Location[];
  members: OrganizationMember[];
  canDelete: boolean;
  busy: boolean;
  onSave: (changes: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onCancel: () => void;
}

/**
 * Editing a task in place.
 *
 * Sends only what actually changed. That is not an optimisation — the API
 * treats a present key as an instruction, so posting the whole form would
 * re-assert the location and assignee on every save, and an editor whose
 * authority ends at one branch would be refused for touching a field they
 * never meant to touch.
 *
 * Status is deliberately absent: it stays on the row itself, where the person
 * holding the task can reach it without opening an editor they may not be
 * allowed to use.
 */
export function TaskEditor({
  task,
  locations,
  members,
  canDelete,
  busy,
  onSave,
  onDelete,
  onCancel,
}: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function save(form: FormData) {
    const title = String(form.get('title') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    const priority = String(form.get('priority') ?? '');
    const day = String(form.get('dueAt') ?? '');
    const locationId = String(form.get('locationId') ?? '');
    const assignee = String(form.get('assigneeMembershipId') ?? '');

    // A date input gives a bare day; the API wants a real instant. Kept at the
    // same hour the create form uses so a task does not shift when edited.
    const dueAt = day ? new Date(`${day}T17:00:00`).toISOString() : null;

    const changes: Record<string, unknown> = {};

    if (title !== task.title) changes.title = title;
    if (description !== (task.description ?? '')) changes.description = description;
    if (priority !== task.priority) changes.priority = priority;
    if (day !== dayOf(task.dueAt)) changes.dueAt = dueAt;
    if (locationId !== (task.locationId ?? '')) changes.locationId = locationId || null;
    if (assignee !== (task.assigneeMembershipId ?? '')) {
      changes.assigneeMembershipId = assignee || null;
    }

    // Nothing touched. Saying so is better than a request that changes
    // nothing and reports success.
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }

    if (await onSave(changes)) onCancel();
  }

  return (
    <form
      action={save}
      className="mt-3 flex w-full flex-col gap-3 border-t border-[var(--color-line)] pt-3"
    >
      <input
        name="title"
        required
        defaultValue={task.title}
        maxLength={200}
        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2"
      />
      <textarea
        name="description"
        rows={2}
        defaultValue={task.description ?? ''}
        placeholder="Any detail worth keeping (optional)"
        className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Priority">
          <select name="priority" defaultValue={task.priority} className={SELECT}>
            {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Due">
          <input type="date" name="dueAt" defaultValue={dayOf(task.dueAt)} className={SELECT} />
        </Field>

        <Field label="Location">
          <select name="locationId" defaultValue={task.locationId ?? ''} className={SELECT}>
            <option value="">Company-wide</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Assign to">
          <select
            name="assigneeMembershipId"
            defaultValue={task.assigneeMembershipId ?? ''}
            className={SELECT}
          >
            <option value="">Nobody yet</option>
            {members.map((member) => (
              <option key={member.membershipId} value={member.membershipId}>
                {[member.firstName, member.lastName].filter(Boolean).join(' ') || member.email}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <p className="text-xs text-[var(--color-muted)]">
        Handing this to somebody else tells them. Taking it off somebody does not.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg border border-transparent bg-[var(--color-ink)] px-3 py-2 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? '…' : 'Save'}
        </button>

        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-xs"
        >
          Cancel
        </button>

        {canDelete &&
          // Cancelling already says "this is not happening" without erasing
          // that it was ever asked for, so deleting is the rarer, sharper
          // tool and asks first.
          (confirmingDelete ? (
            <span className="ml-auto flex items-center gap-2 text-xs">
              <span className="text-[var(--color-muted)]">Delete permanently?</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onDelete()}
                className="rounded-lg border border-[var(--color-bad)] px-3 py-2 text-xs text-[var(--color-bad)] disabled:opacity-50"
              >
                Yes, delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="rounded-lg border border-[var(--color-line)] px-3 py-2 text-xs"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="ml-auto text-xs text-[var(--color-muted)] underline underline-offset-4"
            >
              Delete
            </button>
          ))}
      </div>
    </form>
  );
}

/**
 * The date input wants a local day, and the instant is stored in UTC.
 *
 * Formatted from the local parts rather than sliced off the ISO string: a due
 * date late in the evening is already tomorrow in UTC, and slicing would show
 * the wrong day and then silently save it.
 */
function dayOf(iso: string | null): string {
  if (iso === null) return '';

  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}
