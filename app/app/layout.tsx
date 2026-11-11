import type { ReactNode } from 'react';
import { Fraunces, Geist, Geist_Mono, Instrument_Serif, Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Fonts per docs/ui/README.md Typography. Dashboard: Geist + Geist Mono. Client surfaces: Fraunces, Inter,
// JetBrains Mono. Each is exposed as a CSS variable that globals.css maps to font-sans / font-mono / font-display.
const geistSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap' });
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' });
// Client glass surfaces (/c, /pay, /r): display serif.
const instrumentSerif = Instrument_Serif({ subsets: ['latin'], weight: '400', style: ['normal', 'italic'], variable: '--font-instrument-serif', display: 'swap' });

export const metadata = { title: 'UseRight' };

export default function RootLayout({ children }: { children: ReactNode }) {
  const fonts = [geistSans, geistMono, fraunces, inter, jetbrainsMono, instrumentSerif].map((f) => f.variable).join(' ');
  return (
    <html lang="en" className={fonts}>
      <body>{children}</body>
    </html>
  );
}
