import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Primer',
  description: 'A voice-based AI reading companion',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
