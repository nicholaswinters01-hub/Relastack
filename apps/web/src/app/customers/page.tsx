import Link from 'next/link';
import { AppNav } from '@/components/app-nav';
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
      <>
        <AppNav current="customers" />
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
      </>
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
    <>
      <AppNav current="customers" />
      <main className="mx-auto max-w-4xl px-6 py-16">
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

        {/*
          Stays on the page rather than moving into the navigation. The nav
          carries the places you go; this is a setting that belongs to the
          screen you are already on, and it is only offered to someone who can
          actually change the vocabulary for the whole company.
        */}
        {canConfigure && (
          <p className="mt-10 text-sm">
            <Link href="/customers/settings" className="underline underline-offset-4">
              Manage tags and custom fields
            </Link>
          </p>
        )}
      </main>
    </>
  );
}
