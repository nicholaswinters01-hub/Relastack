import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MODULES } from '@platform/shared';
import { AppNav } from '@/components/app-nav';
import { DashboardView } from '@/components/dashboard-view';
import { getCurrentOrganization, getCurrentUser, getDashboard, getModules } from '@/lib/api';

// The dashboard, replacing the Phase 0 status page this route used to hold.

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await getCurrentUser();

  if (!user) redirect('/login');

  const organization = await getCurrentOrganization();

  if (!organization) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">You are signed in</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          Your account does not belong to an organization yet.
        </p>
      </main>
    );
  }

  const modules = await getModules();
  const reporting = modules.find((module) => module.key === MODULES.REPORTING);

  const greeting = user.firstName ? `Morning, ${user.firstName}` : organization.organization.name;

  if (!reporting?.enabled) {
    return (
      <>
        <AppNav current="dashboard" />
        <main className="mx-auto max-w-4xl px-6 py-16">
          <h1 className="text-3xl font-semibold tracking-tight">{greeting}</h1>
          <p className="mt-3 text-[var(--color-muted)]">
            {reporting?.entitled
              ? 'Turn on Reporting to see how the business is doing at a glance.'
              : 'Reporting is not included in your plan.'}
          </p>
          <p className="mt-6 text-sm">
            <Link
              href={reporting?.entitled ? '/modules' : '/billing'}
              className="underline underline-offset-4"
            >
              {reporting?.entitled ? 'Turn it on' : 'See plans'}
            </Link>
          </p>
        </main>
      </>
    );
  }

  const dashboard = await getDashboard();

  return (
    <>
      <AppNav current="dashboard" />
      <main className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{greeting}</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          Where {organization.organization.name} stands over the last thirty days.
        </p>

        {dashboard ? (
          <DashboardView dashboard={dashboard} />
        ) : (
          <p className="mt-8 rounded-xl border border-dashed border-[var(--color-line)] p-8 text-center text-sm text-[var(--color-muted)]">
            We could not load your figures just now.
          </p>
        )}
      </main>
    </>
  );
}
