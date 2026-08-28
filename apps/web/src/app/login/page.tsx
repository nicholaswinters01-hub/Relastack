import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { getCurrentUser } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  // Already signed in — no reason to show a login form.
  if (await getCurrentUser()) redirect('/account');

  return <AuthForm mode="login" />;
}
