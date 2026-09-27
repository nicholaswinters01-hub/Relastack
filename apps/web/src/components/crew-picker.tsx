'use client';

import { useState } from 'react';
import type { MemberGroup, OrganizationMember } from '@platform/shared';
import { GroupDot } from '@/components/employee-groups';

const memberName = (member: OrganizationMember) =>
  [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;

/**
 * Choosing who goes on a job, with a filter by employee group so scheduling
 * shows the field crew rather than everyone.
 *
 * Filtered-out people are hidden, not removed: someone already ticked stays on
 * the crew when the filter changes.
 */
export function CrewPicker({
  members,
  groups,
  name,
  selected = [],
}: {
  members: OrganizationMember[];
  groups: MemberGroup[];
  /** The form field each ticked person is submitted under. */
  name: string;
  selected?: string[];
}) {
  const [group, setGroup] = useState<string | null>(null);
  const usedGroups = groups.filter((g) => members.some((m) => m.groupIds.includes(g.id)));

  return (
    <div className="flex flex-col gap-2">
      {usedGroups.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Show">
          {[null, ...usedGroups.map((g) => g.id)].map((id) => {
            const g = id ? usedGroups.find((x) => x.id === id) : null;
            return (
              <button
                key={id ?? 'everyone'}
                type="button"
                onClick={() => setGroup(id)}
                aria-pressed={group === id}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${
                  group === id
                    ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
                    : 'border-[var(--color-line)] text-[var(--color-muted)]'
                }`}
              >
                {g && <GroupDot color={g.color} />}
                {g ? g.name : 'Everyone'}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {members.map((member) => (
          <label
            key={member.membershipId}
            className={`items-center gap-2 text-sm ${
              group && !member.groupIds.includes(group) ? 'hidden' : 'flex'
            }`}
          >
            <input
              type="checkbox"
              name={name}
              value={member.membershipId}
              defaultChecked={selected.includes(member.membershipId)}
            />
            {memberName(member)}
          </label>
        ))}
      </div>
    </div>
  );
}
