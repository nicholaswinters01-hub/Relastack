'use client';

import { useEffect } from 'react';

/**
 * When a page cannot be built: the API was busy, asleep, or unreachable.
 *
 * Deliberately not a sign-in page. The session is fine; sending someone to
 * sign in again for a server hiccup loses their place for nothing.
 */
export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">That didn&apos;t load</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        RelaStack is busy or waking up. You are still signed in, and nothing you saved is lost. Try
        again in a moment.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="mt-6 self-start rounded-lg bg-[var(--color-ink)] px-4 py-2.5 text-sm font-medium text-[var(--color-canvas)]"
      >
        Try again
      </button>
    </main>
  );
}
