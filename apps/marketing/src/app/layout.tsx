import type { Metadata } from 'next';
import { BRAND } from '@/lib/brand';
import './globals.css';

export const metadata: Metadata = {
  title: `${BRAND.productName} — ${BRAND.tagline}`,
  description:
    'One platform for running an independent business: customers, scheduling, staff and stock. Priced per location, never per user.',
  // Nothing here should be indexed under a placeholder name. Remove this once
  // the product is actually named and the copy is final.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
