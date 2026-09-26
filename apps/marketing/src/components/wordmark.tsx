import { BRAND } from '@/lib/brand';

/**
 * The name, set the way the logo sets it: navy "Rela", blue "Stack".
 *
 * Text rather than the PNG: it stays crisp at any size, costs no request,
 * inverts correctly in dark mode, and can never render as a broken image. The
 * logo file is still wanted — for the favicon and the social card, where an
 * image is unavoidable — but the header is better off without it.
 *
 * The split is written out as two literal strings rather than sliced from
 * `BRAND.productName`, so a typo in either breaks visibly at compile time
 * instead of silently mis-slicing a renamed product. The assertion below is
 * what keeps them from drifting apart the way the slice would have prevented
 * automatically — if the name ever changes, this fails loudly rather than
 * quietly rendering half of the old one.
 */
const FIRST = 'Rela';
const SECOND = 'Stack';

if (`${FIRST}${SECOND}` !== BRAND.productName) {
  throw new Error(
    `Wordmark halves ("${FIRST}" + "${SECOND}") no longer match BRAND.productName ("${BRAND.productName}")`,
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`font-semibold tracking-tight ${className}`}
      // One accessible name, so a screen reader says "RelaStack" rather than
      // spelling out two adjacent fragments.
      aria-label={BRAND.productName}
      role="img"
    >
      <span aria-hidden="true" className="text-[var(--color-brand)]">
        {FIRST}
      </span>
      <span aria-hidden="true" className="text-[var(--color-accent-ink)]">
        {SECOND}
      </span>
    </span>
  );
}
