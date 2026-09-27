import { redirect } from 'next/navigation';
import { ForgotPasswordForm } from '@/components/password-reset-forms';
import { getCurrentUser } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function ForgotPasswordPage() {
  if (await getCurrentUser()) redirect('/account');

  return <ForgotPasswordForm />;
}
