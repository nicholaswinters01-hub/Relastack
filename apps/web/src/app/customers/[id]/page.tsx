import Link from 'next/link';
import { AppNav } from '@/components/app-nav';
import { notFound, redirect } from 'next/navigation';
import { PERMISSIONS } from '@platform/shared';
import { CustomerDetailView } from '@/components/customer-detail';
import { getCurrentOrganization, getCustomFields, getCustomer, getTags } from '@/lib/api';
import { can, canAt } from '@/lib/permissions';

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

  const [tags, fields] = await Promise.all([getTags(), getCustomFields()]);

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
      </main>
    </>
  );
}
