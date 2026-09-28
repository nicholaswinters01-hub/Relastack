'use client';

import { useRouter } from 'next/navigation';

/** Choose which branch the board shows, or all of them. */
export function BoardBranchPicker({
  locations,
  selected,
}: {
  locations: Array<{ id: string; name: string }>;
  selected: string | null;
}) {
  const router = useRouter();
  return (
    <select
      value={selected ?? ''}
      onChange={(e) => router.push(e.target.value ? `/board?location=${e.target.value}` : '/board')}
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
