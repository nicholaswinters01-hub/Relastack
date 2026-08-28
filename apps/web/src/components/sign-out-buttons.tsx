'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function SignOutButtons() {
  const router = useRouter();
  const [pending, setPending] = useState<'one' | 'all' | null>(null);

  async function signOut(scope: 'one' | 'all') {
    setPending(scope);

    try {
      // Relative URL so the request goes through the Next.js rewrite and the
      // session cookie is treated as same-origin.
      await fetch(`/api/v1/auth/${scope === 'all' ? 'logout-all' : 'logout'}`, {
        method: 'POST',
        credentials: 'include',
      });

      router.push('/login');
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-6 flex flex-wrap gap-3">
      <button
        onClick={() => signOut('one')}
        disabled={pending !== null}
        className="rounded-lg bg-[var(--color-ink)] px-4 py-2.5 text-sm font-medium text-[var(--color-canvas)] transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending === 'one' ? 'Signing out…' : 'Sign out'}
      </button>

      <button
        onClick={() => signOut('all')}
        disabled={pending !== null}
        className="rounded-lg border border-[var(--color-line)] px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--color-surface)] disabled:opacity-50"
      >
        {pending === 'all' ? 'Revoking…' : 'Sign out everywhere'}
      </button>
    </div>
  );
}
