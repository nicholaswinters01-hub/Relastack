import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS, type CustomerStage } from '@platform/shared';
import { CustomersManager } from '@/components/customers-manager';
import { getCurrentOrganization, getCustomers, getLocations, getModules, getTags } from '@/lib/api';
import { canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{ search?: string; stage?: string; tagId?: string }>;
}

export default async function CustomersPage({ searchParams }: Props) {
  const organization = await getCurrentOrganization();

  if (!organization) redirect('/login');

  const modules = await getModules();
  const crm = modules.find((module) => module.key === MODULES.CRM);

  // The API refuses these routes without the module regardless. Checking here
  // is only so the page can explain itself rather than showing empty lists.
  if (!crm?.enabled) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Customers</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          {crm?.entitled
            ? 'The CRM module is not switched on for your organization yet.'
            : 'The CRM module is not included in your plan.'}
        </p>
        <p className="mt-6 text-sm">
          <Link
            href={crm?.entitled ? '/modules' : '/billing'}
            className="underline underline-offset-4"
          >
            {crm?.entitled ? 'Turn it on' : 'See plans'}
          </Link>
        </p>
      </main>
    );
  }

  const { search, stage, tagId } = await searchParams;

  const [{ customers }, tags, locations] = await Promise.all([
    getCustomers({ search, stage, tagId }),
    getTags(),
    getLocations(),
  ]);

  const canWrite = canAnywhere(organization.permissions, PERMISSIONS.CUSTOMER_WRITE);
  const canConfigure = canAnywhere(organization.permissions, PERMISSIONS.CUSTOMER_CONFIGURE);

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
        Phase 7 — CRM
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Customers</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        Leads and customers are the same record at different stages, so converting one keeps every
        note, contact and tag attached to it.
      </p>

      <CustomersManager
        customers={customers}
        tags={tags}
        locations={locations}
        canWrite={canWrite}
        activeSearch={search ?? ''}
        activeStage={(stage as CustomerStage | undefined) ?? null}
        activeTagId={tagId ?? null}
      />

      <p className="mt-10 flex flex-wrap gap-4 text-sm">
        {canConfigure && (
          <Link href="/customers/settings" className="underline underline-offset-4">
            Tags and fields
          </Link>
        )}
        <Link href="/locations" className="underline underline-offset-4">
          Locations
        </Link>
        <Link href="/modules" className="underline underline-offset-4">
          Modules
        </Link>
        <Link href="/account" className="underline underline-offset-4">
          Your account
        </Link>
      </p>
    </main>
  );
}
