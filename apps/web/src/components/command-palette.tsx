'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchResponseSchema, type SearchResult } from '@platform/shared';

export interface PaletteAction {
  label: string;
  href: string;
  /** More words it should be found by, such as a setting's description. */
  keywords?: string;
}

interface Item {
  key: string;
  label: string;
  detail: string | null;
  group: string;
  href: string;
}

const GROUP: Record<SearchResult['kind'], string> = {
  customer: 'Customers',
  job: 'Jobs',
  task: 'Tasks',
  member: 'Team',
  location: 'Locations',
};

const RECENT_KEY = 'rs-recent';
const RECENT_LIMIT = 8;

/** Per browser, and allowed to fail: private windows and blocked storage just have no recents. */
function readRecent(): Item[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function remember(item: Item): void {
  try {
    const rest = readRecent().filter((entry) => entry.href !== item.href);
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([{ ...item, group: 'Recent' }, ...rest].slice(0, RECENT_LIMIT)),
    );
  } catch {
    // Nothing to do: recents are a convenience.
  }
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Quick search: Ctrl+K (⌘K on a Mac) from anywhere.
 *
 * Results come from the API, which answers with exactly what the person could
 * reach through the list pages. Enter opens; Ctrl+Enter opens in a new window,
 * for the other monitor.
 */
export function CommandPalette({ actions }: { actions: PaletteAction[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [recent, setRecent] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Ctrl+K / ⌘K anywhere; Esc closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((was) => !was);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setActive(0);
    setRecent(readRecent());
    setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  // Searched as you type, a moment after you stop.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/v1/search?q=${encodeURIComponent(term)}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const parsed = searchResponseSchema.safeParse(await response.json());
        if (parsed.success) {
          setResults(parsed.data.results);
          setActive(0);
        }
      } catch {
        // Aborted by the next keystroke, or offline: keep what is shown.
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const items = useMemo<Item[]>(() => {
    const term = query.trim().toLowerCase();
    const matchingActions = actions
      .filter(
        (action) =>
          term === '' || `${action.label} ${action.keywords ?? ''}`.toLowerCase().includes(term),
      )
      .map((action) => ({
        // Label and address: two settings may live on the same page.
        key: `action:${action.label}:${action.href}`,
        label: action.label,
        detail: null,
        group: 'Go to',
        href: action.href,
      }));

    if (term.length < 2) return [...recent, ...matchingActions];

    const found = results.map((result) => ({
      key: `${result.kind}:${result.id}`,
      label: result.title,
      detail:
        [
          result.subtitle,
          result.at
            ? new Date(result.at).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      group: GROUP[result.kind],
      href: result.href,
    }));
    return [...found, ...matchingActions];
  }, [actions, query, recent, results]);

  const go = useCallback(
    (item: Item, newWindow: boolean) => {
      remember(item);
      setOpen(false);
      if (newWindow) window.open(item.href, '_blank', 'noopener');
      else router.push(item.href);
    },
    [router],
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && items[active]) {
      event.preventDefault();
      go(items[active], event.ctrlKey || event.metaKey);
    }
  }

  const shortcut = isMac() ? '⌘K' : 'Ctrl K';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        aria-label="Search"
      >
        <span>Search…</span>
        <kbd className="hidden font-mono text-[11px] sm:inline">{shortcut}</kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Search"
            className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl"
          >
            <input
              ref={input}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search customers, jobs, tasks, people…"
              aria-label="Search"
              className="w-full border-b border-[var(--color-line)] bg-transparent px-4 py-3 text-sm outline-none"
            />

            <ul role="listbox" className="max-h-[60vh] overflow-y-auto py-2">
              {items.length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">
                  {query.trim().length < 2
                    ? 'Type at least two letters.'
                    : loading
                      ? 'Searching…'
                      : 'Nothing found.'}
                </li>
              )}

              {items.map((item, index) => (
                <li key={item.key} role="option" aria-selected={index === active}>
                  {(index === 0 || items[index - 1]!.group !== item.group) && (
                    <p className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                      {item.group}
                    </p>
                  )}
                  <a
                    href={item.href}
                    onMouseEnter={() => setActive(index)}
                    onClick={(event) => {
                      // Middle-click and Ctrl-click are left to the browser.
                      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
                      event.preventDefault();
                      go(item, false);
                    }}
                    className={`flex items-baseline justify-between gap-3 px-4 py-2 text-sm ${
                      index === active ? 'bg-[var(--color-canvas)]' : ''
                    }`}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.detail && (
                      <span className="truncate text-xs text-[var(--color-muted)]">
                        {item.detail}
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>

            <p className="border-t border-[var(--color-line)] px-4 py-2 text-[11px] text-[var(--color-muted)]">
              ↑↓ to move · Enter to open · {isMac() ? '⌘' : 'Ctrl'}+Enter for a new window · Esc to
              close
            </p>
          </div>
        </div>
      )}
    </>
  );
}
