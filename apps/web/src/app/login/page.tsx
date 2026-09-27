import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { getCurrentUser } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>;
}) {
  // Already signed in — no reason to show a login form.
  if (await getCurrentUser()) redirect('/account');

  const { reset } = await searchParams;

  return (
    <AuthForm
      mode="login"
      notice={reset ? 'Your password was changed. Sign in with the new one.' : undefined}
    />
  );
}
