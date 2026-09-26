import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Wordmark } from '@/components/wordmark';
import { currentAdmin, isAdminConfigured } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  invalid: 'That email and password do not match.',
  locked: 'Too many attempts. Try again in 15 minutes.',
  unavailable: 'Sign-in is not set up on this deployment yet.',
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentAdmin()) redirect('/admin');

  const { error } = await searchParams;
  const message = isAdminConfigured() ? MESSAGES[error ?? ''] : MESSAGES.unavailable;

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <Link href="/" className="text-xl">
        <Wordmark />
      </Link>

      <h1 className="mt-8 text-2xl font-semibold tracking-tight">Sign in</h1>

      {message && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-bad)]">
          {message}
        </p>
      )}

      <form method="post" action="/api/admin/login" className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5 text-base font-normal"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2.5 text-base font-normal"
          />
        </label>

        <button
          type="submit"
          className="mt-2 rounded-lg bg-[var(--color-cta)] px-4 py-2.5 text-sm font-medium text-white"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
