import { AcceptInvitationForm } from '@/components/accept-invitation-form';

export const dynamic = 'force-dynamic';

/**
 * The page an invitation link opens.
 *
 * Public: the invitee has no account yet, by definition. The token arrives in
 * the query string, which is unavoidable for a link — mitigated by the token
 * being single-use, expiring, and stored only as a hash.
 */
export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return <AcceptInvitationForm token={token ?? ''} />;
}
