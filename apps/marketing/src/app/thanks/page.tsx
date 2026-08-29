import Link from 'next/link';
import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = {
  title: `You're on the list — ${BRAND.productName}`,
  robots: { index: false, follow: false },
};

/**
 * Where a plain form post lands.
 *
 * With JavaScript the form swaps itself for a confirmation in place and nobody
 * comes here. This page exists so the site still works with scripting blocked
 * — which, for a page whose entire purpose is a form, is worth the extra file.
 */
export default function ThanksPage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Thanks.</h1>

      <p className="mt-4 leading-relaxed text-[var(--color-muted)]">
        You&apos;re on the list. We&apos;ll email you when there&apos;s something to see — and about
        nothing else.
      </p>

      <p className="mt-4 leading-relaxed text-[var(--color-muted)]">
        If a confirmation email is on its way, do click the link in it. Without that click we
        can&apos;t email you at all.
      </p>

      <p className="mt-8 flex flex-wrap gap-4 text-sm">
        <Link href="/" className="underline underline-offset-4">
          Back to the start
        </Link>
        <Link href="/privacy" className="underline underline-offset-4">
          How we handle your data
        </Link>
      </p>
    </main>
  );
}
