'use client';
// Batch 8 §2: the pay page's renewal choice. One unticked checkbox, saved on the licence by a same-origin POST to
// /api/pay/:token/renewal; it can change before and after payment, until the renewal invoice is out.
import { useEffect, useState } from 'react';
import { shortDate } from '@/lib/format';
import type { PayView } from '@/lib/pay';

export const RENEWAL_LABEL = 'Send me a renewal invoice before this licence ends';

export function RenewalOptIn({ token, view, onView }: { token: string; view: PayView; onView: (v: PayView) => void }) {
  const optIn = view.renewal?.optIn ?? false;
  const canChange = view.renewal?.canChange ?? false;
  const [checked, setChecked] = useState(optIn);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The page polls every 3 s; a fresh view wins unless a save is in flight.
  useEffect(() => { if (!saving) setChecked(optIn); }, [optIn, saving]);

  if (!canChange && !optIn) return null;

  async function change(next: boolean) {
    setChecked(next);
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/pay/${token}/renewal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ optIn: next }) });
      const body = await res.json().catch(() => ({})) as { view?: PayView; error?: string };
      if (!res.ok || !body.view) {
        setChecked(!next);
        setError(body.error ?? 'Could not save your choice. Try again.');
        return;
      }
      onView(body.view);
      setNote(next ? 'Saved. You will get a renewal invoice before the licence ends.' : 'Saved. No renewal invoice will be sent.');
    } catch {
      setChecked(!next);
      setError('Could not reach the server. Check your connection, then try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-1.5 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-xs">
      <label className={`flex items-start gap-3 ${canChange && !saving ? 'cursor-pointer' : ''}`}>
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-[var(--g-accent)]"
          checked={checked}
          disabled={!canChange || saving}
          onChange={(e) => void change(e.target.checked)}
          aria-describedby="renewal-note"
        />
        <span className="text-white">{RENEWAL_LABEL}</span>
      </label>
      <p id="renewal-note" aria-live="polite" className={error ? 'text-[var(--g-danger)]' : 'g-muted'}>
        {error ?? note ?? (!canChange
          ? 'Renewal requested. The renewal invoice is already on its way.'
          : view.term.endAt ? `This licence ends on ${shortDate(view.term.endAt)}. The invoice comes about a week before.` : 'The invoice comes about a week before the licence ends.')}
      </p>
    </div>
  );
}
