import Link from 'next/link';
import { redirect } from 'next/navigation';
import { INTEGRATION_PROVIDERS, PERMISSIONS } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { ConnectedApps } from '@/components/connected-apps';
import { getCurrentOrganization, getIntegrations } from '@/lib/api';
import { can } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  declined: 'The connection was not approved, so nothing was connected.',
  expired: 'That connect link had expired or was already used. Try connecting again.',
  refused:
    'The service refused the connection. Try again, or check the account you signed in with.',
  unavailable: 'The service could not be reached. Try again in a moment.',
};

/**
 * Connected apps: where the provider sends the owner back after approving,
 * with ?connected= or ?error= saying how it went.
 */
export default async function ConnectedAppsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; provider?: string }>;
}) {
  const organization = await getCurrentOrganization();
  if (!organization) redirect('/login');

  const query = await searchParams;
  const canManage = can(organization.permissions, PERMISSIONS.ORGANIZATION_WRITE);
  const data = canManage ? await getIntegrations() : null;
  const nameOf = (key?: string) =>
    INTEGRATION_PROVIDERS.find((provider) => provider.key === key)?.name ?? 'The service';

  return (
    <>
      <AppNav current="settings" />
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <Link
          href="/settings?section=business"
          className="text-sm text-[var(--color-muted)] underline underline-offset-4"
        >
          Settings
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Connected apps</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          Accounts your business already uses, connected so RelaStack can work with them. Your
          documents stay in those accounts; RelaStack never keeps a copy.
        </p>

        {query.connected && (
          <p className="mt-6 rounded-lg border border-[var(--color-ok)] p-3 text-sm">
            {nameOf(query.connected)} is connected.
          </p>
        )}
        {query.error && (
          <p className="mt-6 rounded-lg border border-[var(--color-bad)] p-3 text-sm">
            {ERRORS[query.error] ?? 'Something went wrong connecting.'}
          </p>
        )}

        {!canManage ? (
          <p className="mt-6 text-sm text-[var(--color-muted)]">
            Connected apps are managed by the business&apos;s owners and admins.
          </p>
        ) : !data ? (
          <p className="mt-6 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
            We could not load your connected apps just now.
          </p>
        ) : (
          <ConnectedApps data={data} />
        )}
      </main>
    </>
  );
}
