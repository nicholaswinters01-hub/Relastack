import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { getCurrentUser } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect('/account');

  return <AuthForm mode="register" />;
}
