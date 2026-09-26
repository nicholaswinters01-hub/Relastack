import { BRAND } from '@/lib/brand';

/**
 * The name, set as plain text — a placeholder, not a finished mark.
 *
 * The old wordmark hard-coded a split "Biz"/"Foundry" colouring taken
 * straight from that logo. Relastack does not split the same way and has no
 * supplied mark yet, so this deliberately does nothing clever: one weight,
 * one colour, pulled from `BRAND.productName` so it can never drift from the
 * name used everywhere else.
 *
 * REPLACE THIS once the real Relastack logo exists. If the mark ends up
 * using a colour split or a genuine logotype, this is the one place that
 * needs to change — every page imports the component, not the string.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-semibold tracking-tight text-[var(--color-brand)] ${className}`}>
      {BRAND.productName}
    </span>
  );
}
