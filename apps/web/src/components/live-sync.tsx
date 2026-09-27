'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { listen } from '@/lib/live-sync';

/** How often a visible window catches up with colleagues' changes. */
const COLLEAGUE_REFRESH_MS = 60_000;
/** Several changes in quick succession become one refresh. */
const DEBOUNCE_MS = 300;

/**
 * Refreshes this window's data when it may be out of date.
 *
 * - Another window of this browser changed something: within a second.
 * - Coming back to this window, or every minute while it is on screen:
 *   catches what colleagues changed.
 * - Never while hidden, so an idle database can go to sleep.
 * - Signed out elsewhere: this window goes to the sign-in page too.
 *
 * A refresh re-renders the page's data and leaves open forms and typing alone.
 */
export function LiveSync() {
  const router = useRouter();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const refresh = () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => router.refresh(), DEBOUNCE_MS);
    };

    const stop = listen((message) => {
      if (message.type === 'signed-out') {
        window.location.href = '/login';
        return;
      }
      // A hidden window catches up when it is shown again, below.
      if (document.visibilityState === 'visible') refresh();
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const onFocus = () => refresh();

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, COLLEAGUE_REFRESH_MS);

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);

    return () => {
      stop();
      clearInterval(timer);
      if (pending.current) clearTimeout(pending.current);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [router]);

  return null;
}
