import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Yupoo → WooCommerce Importer',
  description: 'Scrape Yupoo albums and import them as WooCommerce products',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
