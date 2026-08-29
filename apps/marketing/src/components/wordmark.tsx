/**
 * The name, set the way the logo sets it.
 *
 * Text rather than the PNG: it stays crisp at any size, costs no request,
 * inverts correctly in dark mode, and can never render as a broken image. The
 * logo file is still wanted — for the favicon and the social card, where an
 * image is unavoidable — but the header is better off without it.
 *
 * The split colouring is the logo's, not decoration: navy "Biz", orange
 * "Foundry".
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`font-semibold tracking-tight ${className}`}
      // One accessible name, so a screen reader says "BizFoundry" rather than
      // spelling out two adjacent fragments.
      aria-label="BizFoundry"
      role="img"
    >
      <span aria-hidden="true" className="text-[var(--color-brand)]">
        Biz
      </span>
      <span aria-hidden="true" className="text-[var(--color-accent-ink)]">
        Foundry
      </span>
    </span>
  );
}
