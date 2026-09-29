'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { PASSWORD_MIN_LENGTH, type InvitationPreview } from '@platform/shared';
import { PRIVACY_URL, TERMS_URL } from '@/lib/brand';

type State =
  { status: 'loading' } | { status: 'invalid' } | { status: 'ready'; preview: InvitationPreview };

export function AcceptInvitationForm({ token }: { token: string }) {
  const router = useRouter();

  const [state, setState] = useState<State>({ status: 'loading' });
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setState({ status: 'invalid' });
      return;
    }

    let cancelled = false;

    fetch(`/api/v1/invitations/preview?token=${encodeURIComponent(token)}`)
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setState({ status: 'invalid' });
          return;
        }
        setState({ status: 'ready', preview: await response.json() });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'invalid' });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await fetch('/api/v1/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          token,
          ...(state.status === 'ready' && state.preview.requiresAccount
            ? { password, firstName, lastName }
            : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.errors?.[0]?.message ?? body.message ?? 'Could not accept this invitation');
        return;
      }

      // Accepting signs them in, so there is nowhere to go but in.
      router.push('/account');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'loading') {
    return (
      <main className="mx-auto max-w-md px-6 py-24">
        <p className="text-sm text-[var(--color-muted)]">Checking your invitation…</p>
      </main>
    );
  }

  if (state.status === 'invalid') {
    return (
      <main className="mx-auto max-w-md px-6 py-24">
        <h1 className="text-2xl font-semibold tracking-tight">This invitation is not valid</h1>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          It may have expired, been revoked, or already been used. Ask whoever invited you to send a
          new one.
        </p>
      </main>
    );
  }

  const { preview } = state;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Join {preview.organizationName}</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        You have been invited as {preview.roleName}, as <strong>{preview.email}</strong>.
      </p>

      <form onSubmit={accept} className="mt-8 flex flex-col gap-4">
        {preview.requiresAccount ? (
          <>
            <div className="flex gap-3">
              <label className="flex w-full flex-col gap-1.5">
                <span className="text-sm font-medium">First name</span>
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoComplete="given-name"
                  className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
                />
              </label>
              <label className="flex w-full flex-col gap-1.5">
                <span className="text-sm font-medium">Last name</span>
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  autoComplete="family-name"
                  className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Choose a password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none"
              />
              <span className="text-xs text-[var(--color-muted)]">
                At least {PASSWORD_MIN_LENGTH} characters.
              </span>
            </label>
          </>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">
            You already have an account, so accepting simply adds you to this organization.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-[var(--color-bad)]">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-lg bg-[var(--color-ink)] px-4 py-2.5 text-sm font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? 'Joining…' : `Join ${preview.organizationName}`}
        </button>
      </form>

      <p className="mt-8 text-xs text-[var(--color-muted)]">
        By joining you agree to the{' '}
        <a href={TERMS_URL} className="underline underline-offset-4">
          terms of service
        </a>{' '}
        and the{' '}
        <a href={PRIVACY_URL} className="underline underline-offset-4">
          privacy notice
        </a>
        .
      </p>
    </main>
  );
}
