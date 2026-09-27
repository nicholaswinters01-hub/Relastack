'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Invitation, Location, OrganizationMember, RoleScope } from '@platform/shared';
import { roleLabel } from '@/lib/permissions';
import { apiWrite } from '@/lib/live-sync';

interface Props {
  members: OrganizationMember[];
  invitations: Invitation[];
  locations: Location[];
  canInvite: boolean;
}

/**
 * People and pending invitations.
 *
 * Controls are hidden when the caller cannot use them — a usability courtesy,
 * not a security control. The API enforces the same rules regardless of what
 * this renders, and the e2e suite asserts that calling those endpoints
 * directly still fails.
 */
export function TeamManager({ members, invitations, locations, canInvite }: Props) {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('employee');
  const [scope, setScope] = useState<RoleScope>('LOCATION');
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Shown once, after creating an invitation. Until Phase 11 sends email, this
  // link is how an owner passes the invitation to their colleague — and the
  // server cannot show it again, because only its hash is stored.
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);

  async function invite(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setAcceptUrl(null);
    setBusy(true);

    try {
      const response = await apiWrite('/api/v1/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email,
          roleKey,
          scope,
          locationIds: scope === 'LOCATION' ? locationIds : [],
        }),
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(body.errors?.[0]?.message ?? body.message ?? 'Could not send that invitation');
        return;
      }

      setAcceptUrl(body.acceptUrl);
      setEmail('');
      setLocationIds([]);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await apiWrite(`/api/v1/invitations/${id}`, { method: 'DELETE', credentials: 'include' });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const toggleLocation = (id: string) =>
    setLocationIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );

  return (
    <div className="mt-8 flex flex-col gap-6">
      {canInvite && (
        <form
          onSubmit={invite}
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Invite someone
          </h2>

          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="their@email.com"
                required
                className="min-w-56 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm outline-none"
              />
              <select
                value={roleKey}
                onChange={(e) => {
                  setRoleKey(e.target.value);
                  setScope(e.target.value === 'org_admin' ? 'ORGANIZATION' : 'LOCATION');
                }}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm outline-none"
              >
                <option value="employee">Employee</option>
                <option value="location_manager">Location Manager</option>
                <option value="org_admin">Organization Administrator</option>
              </select>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as RoleScope)}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm outline-none"
              >
                <option value="LOCATION">At specific locations</option>
                <option value="ORGANIZATION">Whole organization</option>
              </select>
            </div>

            {scope === 'LOCATION' && (
              <div className="flex flex-wrap gap-2">
                {locations.length === 0 ? (
                  <span className="text-sm text-[var(--color-muted)]">
                    Create a location first.
                  </span>
                ) : (
                  locations.map((location) => (
                    <button
                      type="button"
                      key={location.id}
                      onClick={() => toggleLocation(location.id)}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                        locationIds.includes(location.id)
                          ? 'border-transparent bg-[var(--color-ink)] text-[var(--color-canvas)]'
                          : 'border-[var(--color-line)]'
                      }`}
                    >
                      {location.name}
                    </button>
                  ))
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="self-start rounded-lg bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Create invitation'}
            </button>
          </div>

          {error && <p className="mt-3 text-sm text-[var(--color-bad)]">{error}</p>}

          {acceptUrl && (
            <div className="mt-4 rounded-lg bg-[var(--color-canvas)] p-3">
              <p className="text-xs font-medium text-[var(--color-muted)]">
                Send this link to your colleague. It is shown once and cannot be recovered — only
                its hash is stored.
              </p>
              <code className="mt-2 block break-all font-mono text-xs">{acceptUrl}</code>
            </div>
          )}
        </form>
      )}

      <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          People ({members.length})
        </h2>

        <ul className="mt-4 flex flex-col gap-3">
          {members.map((member) => {
            const name =
              [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email;

            return (
              <li
                key={member.membershipId}
                className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--color-line)] pb-3 last:border-0 last:pb-0"
              >
                <div>
                  <p className="text-sm font-medium">{name}</p>
                  <p className="text-xs text-[var(--color-muted)]">{member.email}</p>
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
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {invitations.length > 0 && (
        <section className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Pending invitations ({invitations.length})
          </h2>

          <ul className="mt-4 flex flex-col gap-3">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-wrap items-baseline justify-between gap-3"
              >
                <div>
                  <p className="text-sm">{invitation.email}</p>
                  <p className="text-xs text-[var(--color-muted)]">
                    {invitation.roleName} ·{' '}
                    {invitation.scope === 'ORGANIZATION'
                      ? 'whole organization'
                      : `${invitation.locationIds.length} location(s)`}{' '}
                    · expires {new Date(invitation.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                {canInvite && (
                  <button
                    onClick={() => revoke(invitation.id)}
                    disabled={busy}
                    className="rounded-lg border border-[var(--color-line)] px-3 py-1 text-xs font-medium disabled:opacity-50"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
