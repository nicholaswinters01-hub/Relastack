import Link from 'next/link';
import { ResetPasswordForm } from '@/components/password-reset-forms';

export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">This link is incomplete</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Open the link from your email again, or{' '}
          <Link href="/forgot-password" className="underline underline-offset-4">
            ask for a new one
          </Link>
          .
        </p>
      </main>
    );
  }

  return <ResetPasswordForm token={token} />;
}
