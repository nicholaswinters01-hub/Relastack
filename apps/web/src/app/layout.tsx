import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RelaStack',
  description: 'Business software, built around you.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
