import Link from 'next/link';
import { AppNav } from '@/components/app-nav';
import { SettingsLink } from '@/components/settings-link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS, type CustomerStage } from '@platform/shared';
import { CustomersManager } from '@/components/customers-manager';
import { getCurrentOrganization, getCustomers, getLocations, getModules, getTags } from '@/lib/api';
import { can, canAnywhere } from '@/lib/permissions';

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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">Customers</h1>
            <SettingsLink section="customers" />
          </div>
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
      <main className="mx-auto max-w-screen-2xl px-6 py-16">
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">Customers</h1>
            <SettingsLink section="customers" />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            {/* Owners and admins: bulk import is a whole-business decision. */}
            {can(organization.permissions, PERMISSIONS.CUSTOMER_WRITE) && (
              <Link href="/customers/import" className="underline underline-offset-4">
                Import from a spreadsheet
              </Link>
            )}
            {/* Plain links: the browser downloads the file the API names. */}
            {canAnywhere(organization.permissions, PERMISSIONS.CUSTOMER_EXPORT) && (
              <span className="text-[var(--color-muted)]">
                Export:{' '}
                <a
                  href="/api/v1/customers/export/customers"
                  className="text-[var(--color-ink)] underline underline-offset-4"
                >
                  customers
                </a>
                {' · '}
                <a
                  href="/api/v1/customers/export/contacts"
                  className="text-[var(--color-ink)] underline underline-offset-4"
                >
                  contacts
                </a>
                {' · '}
                <a
                  href="/api/v1/customers/export/notes"
                  className="text-[var(--color-ink)] underline underline-offset-4"
                >
                  notes
                </a>
              </span>
            )}
          </div>
        </div>
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
