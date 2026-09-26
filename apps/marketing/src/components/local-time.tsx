'use client';

/** Rendered in the reader's own timezone; the server only knows UTC. */
export function LocalTime({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  );
}
