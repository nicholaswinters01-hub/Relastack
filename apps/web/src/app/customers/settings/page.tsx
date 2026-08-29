import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PERMISSIONS } from '@platform/shared';
import { CrmSettings } from '@/components/crm-settings';
import { getCurrentOrganization, getCustomFields, getTags } from '@/lib/api';
import { can } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function CrmSettingsPage() {
  const organization = await getCurrentOrganization();

  if (!organization) redirect('/login');

  // Organization-wide: adding a required field or renaming a tag changes what
  // every colleague at every branch sees.
  if (!can(organization.permissions, PERMISSIONS.CUSTOMER_CONFIGURE)) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Tags and fields</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          Changing these affects everyone in the company, so it needs an organization-wide role.
        </p>
        <p className="mt-6 text-sm">
          <Link href="/customers" className="underline underline-offset-4">
            Back to customers
          </Link>
        </p>
      </main>
    );
  }

  const [tags, fields] = await Promise.all([getTags(), getCustomFields(true)]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-sm">
        <Link href="/customers" className="underline underline-offset-4">
          Back to customers
        </Link>
      </p>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Tags and fields</h1>
      <p className="mt-3 text-[var(--color-muted)]">
        Fields you define here appear on every customer. Retiring one hides it without touching
        anything already recorded, so bringing it back brings the history with it.
      </p>

      <CrmSettings tags={tags} fields={fields} />
    </main>
  );
}
