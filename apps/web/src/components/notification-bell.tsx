'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Notification } from '@platform/shared';
import { apiWrite } from '@/lib/live-sync';

/**
 * The bell.
 *
 * Deliberately unglamorous. What matters is that the count is honest — it
 * comes from a separate query rather than the length of the page, so a
 * truncated list still totals correctly — and that opening the panel does not
 * mark everything read behind your back. People check a bell to decide what to
 * act on; clearing it for them loses the list they were about to use.
 */
export function NotificationBell({
  notifications,
  unread,
}: {
  notifications: Notification[];
  unread: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function markAllRead() {
    setBusy(true);

    try {
      await apiWrite('/api/v1/notifications/read', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [] }),
      });

      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative rounded-lg px-2 py-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]"
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-[var(--color-bad)] px-1 text-center text-[10px] font-semibold leading-4 text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click anywhere else to dismiss, without a library. */}
          <button
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />

          <div className="absolute right-0 z-20 mt-2 w-80 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-lg">
            <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-2.5">
              <span className="text-sm font-semibold">Notifications</span>
              {unread > 0 && (
                <button
                  onClick={markAllRead}
                  disabled={busy}
                  className="text-xs text-[var(--color-muted)] underline underline-offset-4 disabled:opacity-50"
                >
                  {busy ? '…' : 'Mark all read'}
                </button>
              )}
            </div>

            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
                  Nothing yet.
                </p>
              ) : (
                notifications.map((notification) => {
                  const body = (
                    <>
                      <p className="text-sm font-medium">{notification.title}</p>
                      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                        {notification.body}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-[var(--color-muted)]">
                        {new Date(notification.createdAt).toLocaleString()}
                      </p>
                    </>
                  );

                  const className = `block w-full border-b border-[var(--color-line)] px-4 py-3 text-left last:border-b-0 ${
                    notification.readAt === null ? 'bg-[var(--color-canvas)]' : ''
                  }`;

                  return notification.linkPath ? (
                    <Link
                      key={notification.id}
                      href={notification.linkPath}
                      onClick={() => setOpen(false)}
                      className={`${className} hover:bg-[var(--color-canvas)]`}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div key={notification.id} className={className}>
                      {body}
                    </div>
                  );
                })
              )}
            </div>

            <Link
              href="/account"
              onClick={() => setOpen(false)}
              className="block border-t border-[var(--color-line)] px-4 py-2.5 text-center text-xs text-[var(--color-muted)] underline underline-offset-4"
            >
              Choose what you are told about
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
