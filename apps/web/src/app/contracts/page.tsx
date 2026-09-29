import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MODULES, PERMISSIONS, contractStatusSchema } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { getContracts, getCurrentOrganization, getModules } from '@/lib/api';
import { CONTRACT_STATUS } from '@/lib/contract-labels';
import { canAnywhere } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

/**
 * Every contract sent, for customers the reader can see. Sending happens from
 * each customer's page, where the details to fill in are.
 */
export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const query = await searchParams;
  const status = contractStatusSchema.safeParse(query.status).data;
  const modules = await getModules();
  const on = modules.some((m) => m.key === MODULES.CONTRACTS && m.enabled);
  const canRead = canAnywhere(organization.permissions, PERMISSIONS.CUSTOMER_READ);
  const contracts = on && canRead ? await getContracts({ status }) : null;

  const tab = (value: string | undefined, label: string) => (
    <Link
      key={label}
      href={value ? `/contracts?status=${value}` : '/contracts'}
      className={`rounded-full border px-3 py-1 text-xs ${
        status === value
          ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
          : 'border-[var(--color-line)] text-[var(--color-muted)]'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <>
      <AppNav current="contracts" />
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">Contracts</h1>

        {!on ? (
          <p className="mt-3 text-[var(--color-muted)]">
            Contracts are included in the Pro and Business plans.{' '}
            <Link href="/plans" className="underline underline-offset-4">
              Compare plans
            </Link>
          </p>
        ) : !contracts ? (
          <p className="mt-6 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
            We could not load contracts just now.
          </p>
        ) : (
          <>
            <p className="mt-2 text-[var(--color-muted)]">
              Agreements sent for signature from your DocuSign. Send one from the customer&apos;s
              page.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {tab(undefined, 'All')}
              {tab('SENT', 'Waiting')}
              {tab('VIEWED', 'Opened')}
              {tab('SIGNED', 'Signed')}
              {tab('DECLINED', 'Declined')}
              {tab('VOIDED', 'Withdrawn')}
            </div>
            {contracts.length === 0 ? (
              <p className="mt-6 text-sm text-[var(--color-muted)]">No contracts here yet.</p>
            ) : (
              <ul className="mt-4 flex flex-col divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]">
                {contracts.map((contract) => (
                  <li
                    key={contract.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/customers/${contract.customerId}`}
                        className="text-sm font-medium underline-offset-4 hover:underline"
                      >
                        {contract.title}
                      </Link>
                      <p className="text-xs text-[var(--color-muted)]">
                        {contract.customerName} · to {contract.signerEmail} · sent{' '}
                        {new Date(contract.sentAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                        })}{' '}
                        by {contract.sentByName}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${CONTRACT_STATUS[contract.status].tone}`}
                    >
                      {CONTRACT_STATUS[contract.status].label}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </>
  );
}
