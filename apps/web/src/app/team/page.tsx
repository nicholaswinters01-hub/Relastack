import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PERMISSIONS } from '@platform/shared';
import { TeamManager } from '@/components/team-manager';
import {
  getCurrentOrganization,
  getInvitations,
  getLocations,
  getOrganizationMembers,
} from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const organization = await getCurrentOrganization();

  if (!organization) redirect('/login');

  // "Anywhere" rather than organization-wide: a Location Manager may invite
  // people to the branches they run.
  const canInvite = canAnywhere(organization.permissions, PERMISSIONS.MEMBER_INVITE);

  const [members, invitations, locations] = await Promise.all([
    getOrganizationMembers(),
    canInvite ? getInvitations() : Promise.resolve([]),
    getLocations(),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
        Phase 4 — Roles and permissions
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Your team</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        Employees join by invitation. Signing up directly always creates a new business, so there is
        no way into your organization without one.
      </p>

      <TeamManager
        members={members}
        invitations={invitations}
        locations={locations}
        canInvite={canInvite}
      />

      <p className="mt-10 flex gap-4 text-sm">
        <Link href="/locations" className="underline underline-offset-4">
          Locations
        </Link>
        <Link href="/account" className="underline underline-offset-4">
          Your account
        </Link>
        <Link href="/billing" className="underline underline-offset-4">
          Billing
        </Link>
      </p>
    </main>
  );
}
