'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  PERMISSIONS,
  createLocationRequestSchema,
  type Location,
  type LocationMember,
  type OrganizationMember,
  type ResolvedPermissions,
} from '@platform/shared';
import { canAt } from '@/lib/permissions';

interface Props {
  locations: Location[];
  members: OrganizationMember[];
  permissions: ResolvedPermissions;
  /** Organization-wide: creating a location adds a billable unit. */
  canCreate: boolean;
}

/**
 * Location list, creation, and assignment.
 *
 * Owner-only controls are hidden for members — a usability affordance, not a
 * security control. The API refuses these calls regardless of what the browser
 * renders, which is what the e2e suite asserts.
 */
export function LocationsManager({ locations, members, permissions, canCreate }: Props) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openLocation, setOpenLocation] = useState<string | null>(null);

  async function createLocation(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const payload = { name, city, timezone };
    const parsed = createLocationRequestSchema.safeParse(payload);

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/v1/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.errors?.[0]?.message ?? body.message ?? 'Could not create the location');
        return;
      }

      setName('');
      setCity('');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function toggleAssignment(locationId: string, membershipId: string, assigned: boolean) {
    setBusy(true);
    try {
      await fetch(
        assigned
          ? `/api/v1/locations/${locationId}/members/${membershipId}`
          : `/api/v1/locations/${locationId}/members`,
        {
          method: assigned ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: assigned ? undefined : JSON.stringify({ membershipId }),
          credentials: 'include',
        },
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 flex flex-col gap-6">
      {canCreate && (
        <form
          onSubmit={createLocation}
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Add a location
          </h2>

          <div className="mt-4 flex flex-wrap gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name, e.g. Downtown"
              className="min-w-48 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm outline-none"
            />
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="City"
              className="min-w-36 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm outline-none"
            />
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Timezone"
              className="min-w-48 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 font-mono text-sm outline-none"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
            >
              Add
            </button>
          </div>

          {error && <p className="mt-3 text-sm text-[var(--color-bad)]">{error}</p>}
        </form>
      )}

      {locations.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-muted)]">
          {canCreate
            ? 'No locations yet. Add your first one above.'
            : 'You are not assigned to any locations yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {locations.map((location) => (
            <li
              key={location.id}
              className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{location.name}</h3>
                  <p className="mt-1 text-sm text-[var(--color-muted)]">
                    {[location.city, location.timezone].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-[var(--color-muted)]">
                    {location.memberCount} assigned
                  </span>
                  <span
                    className={`font-mono text-xs ${
                      location.status === 'ACTIVE'
                        ? 'text-[var(--color-ok)]'
                        : 'text-[var(--color-muted)]'
                    }`}
                  >
                    {location.status}
                  </span>
                </div>
              </div>

              {canAt(permissions, PERMISSIONS.LOCATION_ASSIGN, location.id) &&
                members.length > 0 && (
                  <div className="mt-4 border-t border-[var(--color-line)] pt-4">
                    <button
                      onClick={() =>
                        setOpenLocation(openLocation === location.id ? null : location.id)
                      }
                      className="text-sm font-medium underline underline-offset-4"
                    >
                      {openLocation === location.id ? 'Hide' : 'Manage'} people
                    </button>

                    {openLocation === location.id && (
                      <AssignmentList
                        locationId={location.id}
                        members={members}
                        busy={busy}
                        onToggle={toggleAssignment}
                      />
                    )}
                  </div>
                )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AssignmentList({
  locationId,
  members,
  busy,
  onToggle,
}: {
  locationId: string;
  members: OrganizationMember[];
  busy: boolean;
  onToggle: (locationId: string, membershipId: string, assigned: boolean) => void;
}) {
  const [assigned, setAssigned] = useState<string[] | null>(null);

  // Loaded on open rather than with the page: assignments are only needed once
  // someone actually manages a location.
  if (assigned === null) {
    void fetch(`/api/v1/locations/${locationId}/members`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((d: { members: LocationMember[] }) => setAssigned(d.members.map((m) => m.membershipId)))
      .catch(() => setAssigned([]));

    return <p className="mt-3 text-sm text-[var(--color-muted)]">Loading…</p>;
  }

  return (
    <ul className="mt-3 flex flex-col gap-2">
      {members.map((member) => {
        const isAssigned = assigned.includes(member.membershipId);
        const label = [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;

        return (
          <li key={member.membershipId} className="flex items-center justify-between gap-4">
            <span className="text-sm">
              {label}{' '}
              <span className="text-xs text-[var(--color-muted)]">
                ({member.roles.map((role) => role.roleName).join(', ') || 'no role'})
              </span>
            </span>
            <button
              disabled={busy}
              onClick={() => onToggle(locationId, member.membershipId, isAssigned)}
              className={`rounded-lg border px-3 py-1 text-xs font-medium disabled:opacity-50 ${
                isAssigned
                  ? 'border-[var(--color-line)]'
                  : 'border-transparent bg-[var(--color-ink)] text-[var(--color-canvas)]'
              }`}
            >
              {isAssigned ? 'Remove' : 'Assign'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
