import { METER_UNIT, type FleetMeter, type ReminderState } from '@platform/shared';

/**
 * Fleet display helpers. A plain module, not a client component, so server
 * pages get the real values rather than client references.
 */

export const KIND_LABEL: Record<string, string> = {
  VEHICLE: 'Vehicle',
  TRAILER: 'Trailer',
  EQUIPMENT: 'Equipment',
};

export const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'In service',
  IN_SHOP: 'In the shop',
  RETIRED: 'Retired',
};

export const STATE_LABEL: Record<ReminderState, string> = {
  OK: 'Up to date',
  DUE_SOON: 'Due soon',
  OVERDUE: 'Overdue',
};

export const STATE_CLASS: Record<ReminderState, string> = {
  OK: 'border-[var(--color-line)] text-[var(--color-muted)]',
  DUE_SOON: 'border-amber-500 text-amber-600 dark:text-amber-400',
  OVERDUE: 'border-[var(--color-bad)] text-[var(--color-bad)]',
};

export function formatReading(value: number | null, meter: FleetMeter): string {
  if (value === null) return 'No reading yet';
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${METER_UNIT[meter]}`.trim();
}

/** A calendar day (YYYY-MM-DD) as "Oct 1, 2026", without shifting it by time zone. */
export function formatDay(value: string): string {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
