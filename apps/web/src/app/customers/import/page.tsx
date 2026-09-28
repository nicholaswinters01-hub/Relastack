import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { CustomerImporter } from '@/components/customer-importer';
import { getCurrentOrganization, getCustomFields, getLocations } from '@/lib/api';
import { can } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function ImportCustomersPage() {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  // Owners and admins: the API refuses everyone else whatever this shows.
  const allowed = can(organization.permissions, PERMISSIONS.CUSTOMER_WRITE);
  const [locations, customFields] = allowed
    ? await Promise.all([getLocations(), getCustomFields()])
    : [[], []];

  return (
    <>
      <AppNav current="customers" />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <Link
          href="/customers"
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          Customers
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Import customers</h1>
        {allowed ? (
          <>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Bring in your customer list from a spreadsheet or another system. Customers you
              already have are skipped, and nothing is saved until you have checked the file.
            </p>
            <CustomerImporter
              locations={locations.filter((location) => location.status === 'ACTIVE')}
              customFields={customFields}
              canChooseNumbers={can(organization.permissions, PERMISSIONS.CUSTOMER_DELETE)}
            />
          </>
        ) : (
          <p className="mt-4 text-sm text-[var(--color-muted)]">
            Importing is for the business&apos;s owners and admins. Ask one of them to import the
            list.
          </p>
        )}
      </main>
    </>
  );
}
