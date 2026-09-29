import Link from 'next/link';
import { AppNav } from '@/components/app-nav';
import { SettingsLink } from '@/components/settings-link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { ApplicatorLicenses } from '@/components/applicator-licenses';
import { TeamManager } from '@/components/team-manager';
import {
  getCurrentOrganization,
  getGroups,
  getInvitations,
  getLocations,
  getModules,
  getOrganizationMembers,
} from '@/lib/api';
import { can, canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function EmployeesPage() {
  const organization = await getCurrentOrganization();

  if (!organization) redirect('/login');

  // "Anywhere" rather than organization-wide: a Location Manager may invite
  // people to the branches they run.
  const canInvite = canAnywhere(organization.permissions, PERMISSIONS.MEMBER_INVITE);

  // Organization-wide, like the API: groups belong to the whole business.
  const canManage = can(organization.permissions, PERMISSIONS.MEMBER_MANAGE);

  const [members, groups, invitations, locations, modules] = await Promise.all([
    getOrganizationMembers(),
    getGroups(),
    canInvite ? getInvitations() : Promise.resolve([]),
    getLocations(),
    getModules(),
  ]);
  const pestOn = modules.some((m) => m.key === MODULES.PEST_CONTROL && m.enabled);

  return (
    <>
      <AppNav current="employees" />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Employees</h1>
          <div className="flex items-center gap-4">
            {canAnywhere(organization.permissions, PERMISSIONS.MEMBER_REVIEW) && (
              <Link href="/board/performance" className="text-sm underline underline-offset-4">
                Performance
              </Link>
            )}
            <SettingsLink section="people" />
          </div>
        </div>
        <p className="mt-3 text-[var(--color-muted)]">
          Employees join by invitation. Signing up directly always creates a new business, so there
          is no way into your organization without one.
        </p>

        <TeamManager
          members={members}
          groups={groups}
          canManage={canManage}
          invitations={invitations}
          locations={locations}
          canInvite={canInvite}
        />

        {pestOn && canManage && <ApplicatorLicenses members={members} />}
      </main>
    </>
  );
}
