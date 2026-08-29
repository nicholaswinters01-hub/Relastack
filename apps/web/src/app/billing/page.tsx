import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PERMISSIONS } from '@platform/shared';
import { BillingManager } from '@/components/billing-manager';
import { getCurrentOrganization, getPlans, getSubscription } from '@/lib/api';
import { can } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const organization = await getCurrentOrganization();

  if (!organization) redirect('/login');

  // Organization-wide authority. A Location Manager's scoped grant must not
  // let them change what the whole company pays.
  const canManage = can(organization.permissions, PERMISSIONS.ORGANIZATION_WRITE);

  const [billing, plans] = await Promise.all([getSubscription(), getPlans()]);

  if (!billing) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          We could not load your subscription. Try again in a moment.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
        Phase 6 — Billing
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        {organization.organization.name}
      </h1>
      <p className="mt-3 text-[var(--color-muted)]">
        You are billed by business location. Adding people never costs more, and a failed payment
        never locks you out of your own data.
      </p>

      <BillingManager
        subscription={billing.subscription}
        summary={billing.summary}
        plans={plans}
        canManage={canManage}
      />

      <p className="mt-10 flex flex-wrap gap-4 text-sm">
        <Link href="/modules" className="underline underline-offset-4">
          Modules
        </Link>
        <Link href="/locations" className="underline underline-offset-4">
          Locations
        </Link>
        <Link href="/team" className="underline underline-offset-4">
          Your team
        </Link>
        <Link href="/account" className="underline underline-offset-4">
          Your account
        </Link>
      </p>
    </main>
  );
}
