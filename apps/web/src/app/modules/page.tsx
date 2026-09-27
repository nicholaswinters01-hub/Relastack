import { AppNav } from '@/components/app-nav';
import { redirect } from 'next/navigation';
import { PERMISSIONS } from '@platform/shared';
import { ModulesManager } from '@/components/modules-manager';
import { getCurrentOrganization, getModules } from '@/lib/api';
import { can } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function ModulesPage() {
  const organization = await getCurrentOrganization();

  if (!organization) redirect('/login');

  // Organization-wide: turning a module on changes what the company is billed
  // for from Phase 6, so a Location Manager's scoped grant must not suffice.
  const canManage = can(organization.permissions, PERMISSIONS.ORGANIZATION_WRITE);

  const modules = await getModules();
  const enabledCount = modules.filter((module) => module.enabled).length;

  return (
    <>
      <AppNav current="modules" />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {organization.organization.name}
        </h1>
        <p className="mt-3 text-[var(--color-muted)]">
          Capabilities activate for the whole company, not per location or per person. Turning one
          off stops access without deleting anything.
        </p>

        <p className="mt-4 inline-block rounded-lg bg-[var(--color-surface)] px-3 py-1.5 font-mono text-sm">
          {enabledCount} of {modules.length} enabled
        </p>

        <ModulesManager modules={modules} canManage={canManage} />
      </main>
    </>
  );
}
