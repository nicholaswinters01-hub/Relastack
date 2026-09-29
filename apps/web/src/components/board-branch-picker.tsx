'use client';

import { useRouter } from 'next/navigation';

/**
 * Choose which branch the board shows, or all of them. `query` carries the
 * rest of the page's choices (a period, say) across the change.
 */
export function BoardBranchPicker({
  locations,
  selected,
  basePath = '/board',
  query = '',
}: {
  locations: Array<{ id: string; name: string }>;
  selected: string | null;
  basePath?: string;
  query?: string;
}) {
  const router = useRouter();
  const go = (location: string) => {
    const params = new URLSearchParams(query);
    if (location) params.set('location', location);
    else params.delete('location');
    const search = params.toString();
    router.push(search ? `${basePath}?${search}` : basePath);
  };
  return (
    <select
      value={selected ?? ''}
      onChange={(e) => go(e.target.value)}
      aria-label="Branch"
      className="rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm"
    >
      <option value="">All your branches</option>
      {locations.map((location) => (
        <option key={location.id} value={location.id}>
          {location.name}
        </option>
      ))}
    </select>
  );
}
