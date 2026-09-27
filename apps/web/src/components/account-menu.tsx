'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { announce } from '@/lib/live-sync';

export interface MenuLink {
  href: string;
  label: string;
}

interface Props {
  name: string;
  email: string;
  /** Account and business settings this person may open. */
  items: MenuLink[];
  /** The work links, repeated here on narrow screens where the bar hides them. */
  workItems: MenuLink[];
}

/**
 * Everything about the account, kept apart from the work.
 *
 * Each entry is an ordinary link, so it can be opened in a new window. What is
 * listed was already filtered by permission; the API refuses the rest anyway.
 */
export function AccountMenu({ name, email, items, workItems }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      announce({ type: 'signed-out' });
      router.push('/login');
      router.refresh();
    }
  }

  const linkClass =
    'block rounded-md px-3 py-2 text-sm hover:bg-[var(--color-canvas)] focus:bg-[var(--color-canvas)] focus:outline-none';

  return (
    <div ref={menu} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm hover:bg-[var(--color-canvas)]"
      >
        <span className="max-w-40 truncate">{name}</span>
        <span aria-hidden="true" className="text-[var(--color-muted)]">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-2 shadow-xl"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) setOpen(false);
          }}
        >
          <p className="truncate px-3 pb-2 pt-1 text-xs text-[var(--color-muted)]">{email}</p>

          {workItems.length > 0 && (
            <div className="border-t border-[var(--color-line)] py-1 md:hidden">
              {workItems.map((item) => (
                <Link key={item.href} href={item.href} role="menuitem" className={linkClass}>
                  {item.label}
                </Link>
              ))}
            </div>
          )}

          <div className="border-t border-[var(--color-line)] py-1">
            {items.map((item) => (
              <Link key={item.href} href={item.href} role="menuitem" className={linkClass}>
                {item.label}
              </Link>
            ))}
          </div>

          <div className="border-t border-[var(--color-line)] pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => void signOut()}
              disabled={signingOut}
              className={`${linkClass} w-full text-left disabled:opacity-50`}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
