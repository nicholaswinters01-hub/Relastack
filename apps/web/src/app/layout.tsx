import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Platform',
  description: 'Modular business operating platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
