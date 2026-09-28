import Link from 'next/link';
import type { SettingsSectionKey } from '@/lib/settings-catalog';

/**
 * The small "Settings" button beside a page's title. It opens the settings
 * hub at this page's own section.
 */
export function SettingsLink({ section }: { section: SettingsSectionKey }) {
  return (
    <Link
      href={`/settings?section=${section}`}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-line)] px-2.5 py-1.5 text-xs text-[var(--color-muted)] hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <circle cx="10" cy="10" r="2.6" />
        <path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7" />
      </svg>
      Settings
    </Link>
  );
}
