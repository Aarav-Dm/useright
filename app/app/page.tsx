import type { Metadata } from 'next';
import { Landing } from '@/components/landing/landing';

export const metadata: Metadata = {
  title: 'UseRight Agent · Licence the next use',
  description: 'Client briefs become PayPal invoices, priced from your rate card. The file unlocks only when PayPal confirms payment.',
};

export default function Home() {
  return <Landing />;
}
