import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';
import './globals.css';

/**
 * The public origin, used to turn relative asset paths into absolute URLs.
 *
 * Open Graph images must be absolute — a crawler fetching the card has no
 * page-relative context. Without this, Next resolves them against
 * `localhost:3000`, so every shared link would carry an image URL pointing at
 * the sharer's own machine. It builds and deploys perfectly; it just silently
 * never shows a preview.
 */
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
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
