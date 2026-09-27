'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { listen } from '@/lib/live-sync';

/** How often a visible window catches up with colleagues' changes. */
const COLLEAGUE_REFRESH_MS = 60_000;
/** Several changes in quick succession become one refresh. */
const DEBOUNCE_MS = 300;
/** Coming back to a window refreshes it at most this often. */
const RETURN_REFRESH_MS = 15_000;

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
    let last = Date.now();
    let missedChange = false;
    const refresh = () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        last = Date.now();
        router.refresh();
      }, DEBOUNCE_MS);
    };
    // Switching between windows on two monitors happens constantly, and each
    // refresh costs several API calls. Coming back refreshes at most this
    // often; a real change announced by another window always refreshes.
    const refreshIfQuiet = () => {
      if (Date.now() - last >= RETURN_REFRESH_MS) refresh();
    };

    const stop = listen((message) => {
      if (message.type === 'signed-out') {
        window.location.href = '/login';
        return;
      }
      if (document.visibilityState === 'visible') refresh();
      // A hidden window catches up the moment it is shown again.
      else missedChange = true;
    });

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (missedChange) {
        missedChange = false;
        refresh();
      } else {
        refreshIfQuiet();
      }
    };
    const onFocus = () => refreshIfQuiet();

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
