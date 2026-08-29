import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';
import './globals.css';

const FALLBACK_ORIGIN = 'http://localhost:3001';

/**
 * The public origin, used to turn relative asset paths into absolute URLs.
 *
 * Open Graph images must be absolute — a crawler fetching the card has no
 * page-relative context. Without this, Next resolves them against
 * `localhost`, so every shared link carries an image URL pointing at the
 * sharer's own machine: it deploys perfectly and simply never shows a preview.
 *
 * Both failure modes are handled deliberately, because both have happened.
 * `??` is not enough — it falls back on undefined but NOT on an empty string,
 * and a hosting dashboard hands you an empty string for a variable that has
 * been declared and left blank. `new URL('')` then throws and takes the whole
 * build down.
 *
 * A bad value degrades to the fallback rather than failing the build. Losing a
 * preview image is a cosmetic problem; a marketing site that will not deploy
 * because of a typo in a dashboard is a real one. The warning is there so the
 * typo still gets noticed.
 */
function resolveSiteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();

  if (configured) {
    try {
      return new URL(configured);
    } catch {
      console.warn(
        `[marketing] NEXT_PUBLIC_SITE_URL is not a valid URL (${JSON.stringify(configured)}). ` +
          `Falling back to ${FALLBACK_ORIGIN}; social preview images will not resolve.`,
      );
    }
  }

  return new URL(FALLBACK_ORIGIN);
}

const siteUrl = resolveSiteUrl();

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: `${BRAND.productName} — ${BRAND.tagline}`,
  description:
    'One system for running an independent business: customers, scheduling, staff and stock. Turn on the parts you need. Priced per location, never per user.',

  // The social card. Pointing at /logo.png, which is not in the repository
  // yet — drop the mark there and this starts working. Until then a shared
  // link simply shows no image, which is tidier than showing a broken one.
  openGraph: {
    title: `${BRAND.productName} — ${BRAND.tagline}`,
    description:
      'One system for running an independent business. Priced per location, never per user.',
    siteName: BRAND.productName,
    type: 'website',
    images: ['/logo.png'],
  },
  twitter: { card: 'summary_large_image' },

  /*
   * Still noindex. The name is settled, but the legal entity and contact
   * address in brand.ts are placeholders, and a privacy notice naming nobody
   * should not be the first thing a search engine files away. Remove this line
   * once those are real.
   */
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
