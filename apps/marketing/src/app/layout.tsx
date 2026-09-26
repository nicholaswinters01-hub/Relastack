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
  /*
   * SITE_URL, not NEXT_PUBLIC_SITE_URL.
   *
   * The NEXT_PUBLIC_ prefix means "inline this into the JavaScript sent to
   * every browser". This value is only ever read here, in a server component,
   * so the prefix bought nothing and shipped the value to the client for no
   * reason. Harmless for a public domain name — and a habit worth not having,
   * because the next variable someone copies the pattern onto might be a key.
   *
   * The prefixed name is still accepted so that renaming it in the hosting
   * dashboard and deploying this change can happen in either order.
   */
  const configured = (process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL)?.trim();

  if (configured) {
    try {
      return new URL(configured);
    } catch {
      console.warn(
        `[marketing] SITE_URL is not a valid URL (${JSON.stringify(configured)}). ` +
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

  // The social card has no image for now. There WAS a /logo.png here, but it
  // was the old BizFoundry mark — shipping a competitor's name in Relastack's
  // own share previews is worse than shipping none. Drop the real Relastack
  // logo at public/logo.png and restore `images: ['/logo.png']` below.
  openGraph: {
    title: `${BRAND.productName} — ${BRAND.tagline}`,
    description:
      'One system for running an independent business. Priced per location, never per user.',
    siteName: BRAND.productName,
    type: 'website',
  },
  twitter: { card: 'summary_large_image' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
