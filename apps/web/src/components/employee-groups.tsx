'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  GROUP_COLORS,
  type GroupColor,
  type MemberGroup,
  type OrganizationMember,
} from '@platform/shared';
import { GROUP_COLOR_VALUE } from '@/lib/group-colors';
import { apiWrite } from '@/lib/live-sync';
import { roleLabel } from '@/lib/permissions';

const FIELD =
  'rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm';

async function send(path: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const response = await apiWrite(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    return payload.errors?.[0]?.message ?? payload.message ?? 'That did not work.';
  } catch {
    return 'Could not reach the server.';
  }
}

export function GroupDot({ color }: { color: GroupColor }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: GROUP_COLOR_VALUE[color] }}
    />
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: GroupColor;
  onChange: (c: GroupColor) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
      {GROUP_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          onClick={() => onChange(color)}
          className={`h-6 w-6 rounded-full border-2 ${
            value === color ? 'border-[var(--color-ink)]' : 'border-transparent'
          }`}
          style={{ backgroundColor: GROUP_COLOR_VALUE[color] }}
        />
      ))}
    </div>
  );
}

/**
 * The people, filterable by group, with each person's groups beside them.
 *
 * Groups are labels only: they change nothing about what anyone may do. A
 * manager can create them and put people in them; everyone who can see this
 * page can filter by them.
 */
export function EmployeesWithGroups({
  members,
  groups,
  canManage,
}: {
  members: OrganizationMember[];
  groups: MemberGroup[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byId = new Map(groups.map((group) => [group.id, group]));
  const shown = filter ? members.filter((m) => m.groupIds.includes(filter)) : members;

  async function toggle(member: OrganizationMember, groupId: string) {
    setError(null);
    const next = member.groupIds.includes(groupId)
      ? member.groupIds.filter((id) => id !== groupId)
      : [...member.groupIds, groupId];
    const failure = await send(
      `/api/v1/organizations/current/members/${member.membershipId}/groups`,
      'PUT',
      { groupIds: next },
    );
    if (failure) setError(failure);
    else router.refresh();
  }

  const chip = (key: string | null, label: string, color?: GroupColor, count?: number) => (
    <button
      key={key ?? 'all'}
      type="button"
      onClick={() => setFilter(key)}
      aria-pressed={filter === key}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
        filter === key
          ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
          : 'border-[var(--color-line)] text-[var(--color-muted)]'
      }`}
    >
      {color && <GroupDot color={color} />}
      {label}
      {count !== undefined && <span className="opacity-70">{count}</span>}
    </button>
  );

  return (
    <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        People ({members.length})
      </h2>

      {groups.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {chip(null, 'Everyone')}
          {groups.map((group) => chip(group.id, group.name, group.color, group.memberCount))}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-[var(--color-bad)]">{error}</p>}

      <ul className="mt-4 flex flex-col gap-3">
        {shown.length === 0 && (
          <li className="text-sm text-[var(--color-muted)]">Nobody in this group yet.</li>
        )}
        {shown.map((member) => {
          const name =
            [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;

          return (
            <li
              key={member.membershipId}
              className="flex flex-col gap-2 border-b border-[var(--color-line)] pb-3 last:border-0 last:pb-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{name}</p>
                  <p className="text-xs text-[var(--color-muted)]">{member.email}</p>
                  {member.groupIds.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-2">
                      {member.groupIds.map((id) => {
                        const group = byId.get(id);
                        return group ? (
                          <span
                            key={id}
                            className="flex items-center gap-1 text-xs text-[var(--color-muted)]"
                          >
                            <GroupDot color={group.color} />
                            {group.name}
                          </span>
                        ) : null;
                      })}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  {member.roles.length === 0 ? (
                    <span className="font-mono text-xs text-[var(--color-bad)]">no role</span>
                  ) : (
                    member.roles.map((role) => (
                      <p key={role.id} className="font-mono text-xs">
                        {roleLabel(role.roleKey)}
                        <span className="text-[var(--color-muted)]">
                          {' '}
                          ·{' '}
                          {role.scope === 'ORGANIZATION'
                            ? 'whole organization'
                            : `${role.locationIds.length} location${role.locationIds.length === 1 ? '' : 's'}`}
                        </span>
                      </p>
                    ))
                  )}
                  {canManage && groups.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        setAssigning(assigning === member.membershipId ? null : member.membershipId)
                      }
                      className="mt-1 text-xs underline underline-offset-4"
                    >
                      {assigning === member.membershipId ? 'Done' : 'Groups'}
                    </button>
                  )}
                </div>
              </div>

              {assigning === member.membershipId && (
                <div className="flex flex-wrap gap-3 rounded-lg bg-[var(--color-canvas)] p-3">
                  {groups.map((group) => (
                    <label key={group.id} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={member.groupIds.includes(group.id)}
                        onChange={() => void toggle(member, group.id)}
                      />
                      <GroupDot color={group.color} />
                      {group.name}
                    </label>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Creating, renaming and deleting groups. For people who manage the team. */
export function GroupsManager({ groups }: { groups: MemberGroup[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [color, setColor] = useState<GroupColor>('blue');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState<GroupColor>('blue');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(path: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    const failure = await send(path, method, body);
    setBusy(false);
    if (failure) {
      setError(failure);
      return false;
    }
    router.refresh();
    return true;
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (await run('/api/v1/groups', 'POST', { name, color })) setName('');
  }

  return (
    <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        Groups
      </h2>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        Organise people however your business works, for example by who is in the field and who is
        in the office. Groups are for finding people; they don&apos;t change what anyone can see or
        do.
      </p>

      {groups.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {groups.map((group) =>
            editing === group.id ? (
              <li
                key={group.id}
                className="flex flex-col gap-2 rounded-lg bg-[var(--color-canvas)] p-3"
              >
                <input
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  maxLength={60}
                  aria-label="Group name"
                  className={FIELD}
                />
                <ColorPicker value={editColor} onChange={setEditColor} />
                <div className="flex gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await run(`/api/v1/groups/${group.id}`, 'PATCH', {
                          name: editName,
                          color: editColor,
                        })
                      )
                        setEditing(null);
                    }}
                    className="rounded-lg bg-[var(--color-ink)] px-3 py-1.5 text-xs font-medium text-[var(--color-canvas)] disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="text-xs underline underline-offset-4"
                  >
                    Cancel
                  </button>
                </div>
              </li>
            ) : (
              <li
                key={group.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <GroupDot color={group.color} />
                  {group.name}
                  <span className="text-xs text-[var(--color-muted)]">
                    {group.memberCount} {group.memberCount === 1 ? 'person' : 'people'}
                  </span>
                </span>
                {deleting === group.id ? (
                  <span className="flex items-center gap-3 text-xs">
                    Delete this group? People stay as they are.
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        if (await run(`/api/v1/groups/${group.id}`, 'DELETE')) setDeleting(null);
                      }}
                      className="font-medium text-[var(--color-bad)] underline underline-offset-4"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleting(null)}
                      className="underline underline-offset-4"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span className="flex gap-3 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(group.id);
                        setEditName(group.name);
                        setEditColor(group.color);
                      }}
                      className="underline underline-offset-4"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleting(group.id)}
                      className="text-[var(--color-bad)] underline underline-offset-4"
                    >
                      Delete
                    </button>
                  </span>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      <form onSubmit={create} className="mt-4 flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            required
            placeholder="New group, e.g. Field crew"
            aria-label="New group name"
            className={`${FIELD} min-w-56 flex-1`}
          />
          <button
            type="submit"
            disabled={busy || name.trim() === ''}
            className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
          >
            Add group
          </button>
        </div>
        <ColorPicker value={color} onChange={setColor} />
      </form>

      {error && <p className="mt-3 text-sm text-[var(--color-bad)]">{error}</p>}
    </section>
  );
}
