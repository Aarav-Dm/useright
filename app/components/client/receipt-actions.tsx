'use client';

import { useState } from 'react';

export function ReceiptActions() {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Fallback if clipboard API is restricted
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-4 print:hidden">
      <button type="button" className="g-btn g-btn-ghost g-btn-sm" onClick={() => window.print()}>
        Print receipt
      </button>

      <button type="button" className="g-btn g-btn-ghost g-btn-sm" onClick={() => void copyLink()}>
        {copied ? 'Receipt link copied.' : 'Copy receipt link'}
      </button>
    </div>
  );
}
