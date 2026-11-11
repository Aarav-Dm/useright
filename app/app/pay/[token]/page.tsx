// /pay/:token (batch-6 §3, fixes 13, 14, 17, 22). Public client page; no creator cookie.
import type { Metadata } from 'next';
import { PayClient } from '@/components/client/pay-client';
import { demoMode } from '@/lib/clock';

export const metadata: Metadata = { title: 'Licence payment', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PayClient token={token} demo={demoMode()} />;
}