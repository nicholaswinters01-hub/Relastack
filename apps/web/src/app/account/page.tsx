import Link from 'next/link';
import { AppNav } from '@/components/app-nav';
import { redirect } from 'next/navigation';
import { getCurrentOrganization, getCurrentUser } from '@/lib/api';
import { roleLabel } from '@/lib/permissions';
import { SignOutButtons } from '@/components/sign-out-buttons';

export const dynamic = 'force-dynamic';

/**
 * A protected page.
 *
 * The redirect here is a usability affordance, not a security control — it
 * decides what to render, nothing more. The data itself is protected by the
 * API's guards and by row-level security, so calling those endpoints directly
 * without a session returns 401 regardless of what this page does.
 */
export default async function AccountPage() {
  const [user, organization] = await Promise.all([getCurrentUser(), getCurrentOrganization()]);

  if (!user) redirect('/login');

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');

  return (
    <>
      <AppNav current="account" />
      <main className="mx-auto max-w-2xl px-6 py-16">
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
          Phase 4 — Roles and permissions
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {organization?.organization.name ?? 'Your account'}
        </h1>
        <p className="mt-3 text-[var(--color-muted)]">
          {organization
            ? `Signed in as ${user.email}.`
            : 'You are signed in but belong to no organization.'}
        </p>

        {organization && (
          <section className="mt-10 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
              Organization
            </h2>

            <dl className="mt-4">
              <Row label="Name" value={organization.organization.name} />
              <Row label="Slug" value={organization.organization.slug} />
              <Row label="Status" value={organization.organization.status} />
              <Row
                label="Your role"
                value={organization.roles.map(roleLabel).join(', ') || 'None'}
              />
              <Row
                label="Created"
                value={new Date(organization.organization.createdAt).toLocaleDateString()}
              />
            </dl>

            <p className="mt-4 flex gap-4 text-sm">
              <Link href="/locations" className="underline underline-offset-4">
                Manage locations
              </Link>
              <Link href="/team" className="underline underline-offset-4">
                Your team
              </Link>
              <Link href="/modules" className="underline underline-offset-4">
                Modules
              </Link>
              <Link href="/billing" className="underline underline-offset-4">
                Billing
              </Link>
            </p>
          </section>
        )}

        <section className="mt-6 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Account
          </h2>

          <dl className="mt-4">
            <Row label="Email" value={user.email} />
            <Row label="Name" value={fullName || '—'} />
            <Row label="Status" value={user.status} />
            <Row
              label="Last sign-in"
              value={
                user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'This session'
              }
            />
            <Row label="Member since" value={new Date(user.createdAt).toLocaleDateString()} />
          </dl>
        </section>

        <SignOutButtons />

        <p className="mt-8 text-sm text-[var(--color-muted)]">
          Your organization&apos;s data is isolated at the database level, not just in this
          interface — another company cannot read it even if application code asks for it.
        </p>
      </main>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-[var(--color-line)] py-3 last:border-0">
      <dt className="text-sm text-[var(--color-muted)]">{label}</dt>
      <dd className="font-mono text-sm font-medium">{value}</dd>
    </div>
  );
}
