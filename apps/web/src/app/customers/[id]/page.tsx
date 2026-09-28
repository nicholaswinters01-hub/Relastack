import Link from 'next/link';
import { AppNav } from '@/components/app-nav';
import { notFound, redirect } from 'next/navigation';
import { MODULES, PERMISSIONS } from '@platform/shared';
import { CustomerDetailView } from '@/components/customer-detail';
import { PestRecordsTable } from '@/components/pest-records-table';
import {
  getCurrentOrganization,
  getCustomFields,
  getCustomer,
  getModules,
  getPestRecords,
  getTags,
} from '@/lib/api';
import { can, canAnywhere, canAt } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function CustomerPage({ params }: Props) {
  const organization = await getCurrentOrganization();

  if (!organization) redirect('/login');

  const { id } = await params;
  const customer = await getCustomer(id);

  // Null covers both "no such customer" and "not yours to see". The API
  // deliberately does not distinguish them, and neither does this page.
  if (!customer) notFound();

  const [tags, fields, modules] = await Promise.all([getTags(), getCustomFields(), getModules()]);
  // A customer's treatment history, with the Pest Control pack.
  const pestOn =
    modules.some((m) => m.key === MODULES.PEST_CONTROL && m.enabled) &&
    canAnywhere(organization.permissions, PERMISSIONS.JOB_READ);
  const treatments = pestOn ? await getPestRecords({ customerId: customer.id }) : null;

  // Writing is scoped to where the customer sits, so the check has to name
  // that location rather than asking a plain yes/no.
  const canWrite =
    customer.locationId === null
      ? can(organization.permissions, PERMISSIONS.CUSTOMER_WRITE)
      : canAt(organization.permissions, PERMISSIONS.CUSTOMER_WRITE, customer.locationId);

  // Deleting for good (and choosing account numbers) is owner-level and
  // company-wide, like the API check it mirrors.
  const canDelete = can(organization.permissions, PERMISSIONS.CUSTOMER_DELETE);

  return (
    <>
      <AppNav current="customers" />
      <main className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-sm">
          <Link href="/customers" className="underline underline-offset-4">
            Back to customers
          </Link>
        </p>

        <CustomerDetailView
          customer={customer}
          tags={tags}
          fields={fields}
          canWrite={canWrite}
          canDelete={canDelete}
          membershipId={organization.membershipId}
        />

        {treatments && (
          <section className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
              Treatment history
            </h2>
            <PestRecordsTable records={treatments} showCustomer={false} />
          </section>
        )}
      </main>
    </>
  );
}
