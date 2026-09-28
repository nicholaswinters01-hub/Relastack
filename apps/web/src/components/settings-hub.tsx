'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { SettingEntry, SettingsSectionKey } from '@/lib/settings-catalog';

/**
 * Every setting the reader may change, grouped and searchable.
 *
 * Opened from a page's settings button with ?section=, that section is
 * scrolled to and outlined so the reader lands where they meant to go.
 */
export function SettingsHub({
  sections,
  settings,
  focus,
}: {
  sections: Array<{ key: SettingsSectionKey; title: string }>;
  settings: SettingEntry[];
  focus: SettingsSectionKey | null;
}) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (focus) document.getElementById(`settings-${focus}`)?.scrollIntoView({ block: 'start' });
  }, [focus]);

  const needle = query.trim().toLowerCase();
  const matches = (entry: SettingEntry) =>
    !needle ||
    [entry.title, entry.description, entry.keywords ?? ''].join(' ').toLowerCase().includes(needle);
  const shown = sections
    .map((section) => ({
      ...section,
      entries: settings.filter((entry) => entry.section === section.key && matches(entry)),
    }))
    .filter((section) => section.entries.length > 0);

  return (
    <>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a setting: license, password, stock, billing…"
        aria-label="Find a setting"
        className="mt-6 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm"
        autoFocus={!focus}
      />

      {shown.length === 0 && (
        <p className="mt-6 text-sm text-[var(--color-muted)]">
          No setting matches “{query}”. Try another word, or{' '}
          <Link href="/help" className="underline underline-offset-4">
            ask us
          </Link>
          .
        </p>
      )}

      <div className="mt-6 flex flex-col gap-6">
        {shown.map((section) => (
          <section
            key={section.key}
            id={`settings-${section.key}`}
            className={`scroll-mt-20 rounded-xl border bg-[var(--color-surface)] p-5 ${
              focus === section.key && !needle
                ? 'border-[var(--color-ink)]'
                : 'border-[var(--color-line)]'
            }`}
          >
            <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">
              {section.title}
            </h2>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {section.entries.map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={entry.href}
                    className="block h-full rounded-lg border border-[var(--color-line)] p-3 hover:border-[var(--color-ink)]"
                  >
                    <span className="text-sm font-medium">{entry.title}</span>
                    <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                      {entry.description}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
