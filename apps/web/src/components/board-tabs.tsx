import Link from 'next/link';

/** Today's board and how people are doing, side by side for whoever runs a branch. */
export function BoardTabs({
  current,
  showToday,
  showPerformance,
}: {
  current: 'today' | 'performance';
  showToday: boolean;
  showPerformance: boolean;
}) {
  if (!showToday || !showPerformance) return null;
  const tab = (key: typeof current, href: string, label: string) => (
    <Link
      href={href}
      aria-current={current === key ? 'page' : undefined}
      className={`rounded-full border px-3 py-1 text-xs ${
        current === key
          ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-[var(--color-canvas)]'
          : 'border-[var(--color-line)] text-[var(--color-muted)]'
      }`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Board" className="mb-6 flex gap-2">
      {tab('today', '/board', 'Today')}
      {tab('performance', '/board/performance', 'Performance')}
    </nav>
  );
}
