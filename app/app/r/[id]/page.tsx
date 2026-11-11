// /r/:id (batch-6 §6, fix 16): public rights receipt with the licence's live status.
// Batch 7: glass restyle (client experience spec §5); same fields, same headers. Batch 12: a row with no value is left out.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { JourneySteps } from '@/components/client/journey';
import { ReceiptActions } from '@/components/client/receipt-actions';
import { renewalInvoiceDay, shortDate, usd } from '@/lib/format';
import { receiptView } from '@/lib/receipts';
import { deps } from '@/lib/server';
import '@/components/client/glass.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Rights receipt',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

const LIVE: Record<string, string> = {
  active: 'Active',
  superseded: 'Superseded by a newer licence',
  expired: 'Expired',
  refunded: 'Refunded (revoked)',
  pending: 'Not paid',
  draft: 'Not issued',
};

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await receiptView((await deps()).db, id);
  if (!r) notFound();
  const b = r.body;
  const day = (d: string | Date | null) => shortDate(d, r.timeZone);

  const isActive = r.liveStatus === 'active';
  const isRefunded = r.liveStatus === 'refunded' || b.kind === 'revocation';

  return (
    <div className="theme-glass flex min-h-screen flex-col">
      <div className="g-backdrop print:hidden" aria-hidden="true"><div className="g-grain" /></div>
      <header className="mx-auto flex h-16 w-full max-w-2xl items-center justify-between px-6 print:hidden">
        <a href="/c/imani" className="g-display text-2xl">{b.licensor.name}</a>
        <a href="/c/imani" className="text-sm g-muted transition-colors hover:text-white">View work</a>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 p-4 sm:p-6 md:py-10">
        {b.kind === 'grant' && isActive && <JourneySteps current={3} className="mb-6 print:hidden" />}
        <div className="g-card g-rise relative flex flex-col gap-6 overflow-hidden p-6 sm:p-10 print:p-0">
          <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[#ffecd2]/10 blur-3xl print:hidden" aria-hidden="true" />
          <div className="relative flex flex-col justify-between gap-4 border-b border-white/10 pb-6 sm:flex-row sm:items-start">
            <div>
              <p className="text-sm g-muted">
                {/* Security review finding 6: a receipt that says the licence ended must not head itself as proof of it. */}
                {`${b.paypalTransactionId.startsWith('SEED-') ? 'Demo · ' : ''}${b.kind === 'grant' ? 'Proof of licence' : 'Licence record'}`}
              </p>
              <h1 className="g-display mt-2 text-4xl sm:text-5xl">{b.kind === 'revocation' ? 'Revocation receipt' : b.kind === 'expiry' ? 'Expired receipt' : 'Rights receipt'}</h1>
              {/* B16: the receipt in one plain sentence, from its own fields; only while the licence is live. */}
              {isActive && b.kind === 'grant' && (
                <p className="mt-3 max-w-[46ch] text-[15px] leading-relaxed text-white/80">
                  {b.licensee.name} may use “{b.asset.title}” for {b.scope.words}{b.endAt ? `, until ${day(b.endAt)}` : ''}.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1 sm:items-end">
              <span className="g-mono text-[11px] g-muted">Status</span>
              <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
                isActive ? 'border-[var(--g-ok)]/40 bg-[var(--g-ok)]/10 text-[var(--g-ok)]'
                : isRefunded ? 'border-[var(--g-danger)]/40 bg-[var(--g-danger)]/10 text-[var(--g-danger)]'
                : 'border-white/10 bg-white/5 g-muted'}`}>
                <span className={`h-2 w-2 rounded-full ${isActive ? 'bg-[var(--g-ok)]' : isRefunded ? 'bg-[var(--g-danger)]' : 'bg-white/40'}`} aria-hidden="true" />
                {LIVE[r.liveStatus] ?? r.liveStatus}
              </span>
            </div>
          </div>

          <dl className="relative grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
            <dt className="g-muted">Licensor</dt>
            <dd className="font-medium">{b.licensor.name}</dd>

            <dt className="g-muted">Licensee</dt>
            <dd>
              {b.licensee.name}
              {b.licensee.email ? <span className="g-muted"> ({b.licensee.email})</span> : ''}
            </dd>

            {b.licensee.payerEmail && b.licensee.payerEmail !== b.licensee.email && (
              <>
                <dt className="g-muted">PayPal payer</dt>
                <dd className="g-mono text-xs">{b.licensee.payerEmail}</dd>
              </>
            )}

            <dt className="g-muted">Photo</dt>
            <dd className="g-display text-xl">{b.asset.title}</dd>

            <dt className="g-muted">File</dt>
            <dd>{b.asset.fileLabel}</dd>

            <dt className="g-muted col-span-2">File SHA-256</dt>
            <dd className="g-mono break-all text-xs g-muted col-span-2">{b.asset.sha256}</dd>

            <dt className="g-muted">Scope</dt>
            <dd>{b.scope.words}</dd>

            {b.startAt && (
              <>
                <dt className="g-muted">Term</dt>
                <dd>{day(b.startAt)} to {day(b.endAt)}</dd>
              </>
            )}

            <dt className="g-muted">Renewal</dt>
            <dd>{r.renewalOptIn && b.endAt ? `invoice from ${day(renewalInvoiceDay(b.endAt))}, a week before it ends` : 'not requested'}</dd>

            <dt className="g-muted">Price</dt>
            <dd className="g-mono text-lg text-white">
              {usd(b.priceCents)} <span className="text-xs g-muted">{b.currency}</span>
            </dd>

            <dt className="g-muted">PayPal txn id</dt>
            <dd className="g-mono text-xs">
              {b.paypalTransactionId}
              {/* B9 9.5: a seeded receipt must never read as PayPal evidence. */}
              {b.paypalTransactionId.startsWith('SEED-') && <span className="block font-sans g-muted">Demo record, not a PayPal payment</span>}
            </dd>

            {b.invoiceNumber && (
              <>
                <dt className="g-muted">Invoice</dt>
                <dd className="g-mono text-xs">{b.invoiceNumber}</dd>
              </>
            )}

            {r.proof?.lastCheck && (
              <>
                <dt className="g-muted">PayPal re-check</dt>
                <dd>{r.proof.lastCheck.message} <span className="g-muted">({day(r.proof.lastCheck.at)}, read back from PayPal by the server)</span></dd>
              </>
            )}
            {r.proof && (
              <>
                <dt className="g-muted">PayPal webhook</dt>
                <dd>{r.proof.webhook ? <>{r.proof.webhook.type}, signature verified by PayPal <span className="g-muted">({day(r.proof.webhook.at)})</span></> : <span className="g-muted">No webhook for this invoice; the re-check above is the proof</span>}</dd>
              </>
            )}

            <dt className="g-muted">Version</dt>
            <dd>
              v{b.versionNo}
              {b.parentVersionNo ? ` (extends v${b.parentVersionNo})` : ''}
            </dd>

            <dt className="g-muted">Issued</dt>
            <dd>{day(b.issuedAt)}</dd>

            {b.revokedReason && (
              <>
                <dt className="font-medium text-[var(--g-danger)]">Revoked</dt>
                <dd className="font-medium text-[var(--g-danger)]">{b.revokedReason}</dd>
              </>
            )}

            <dt className="g-muted">Collaborator share</dt>
            <dd>{b.collaborator || 'None recorded'}</dd>
          </dl>

          <ReceiptActions />

          <footer className="border-t border-white/10 pt-4 text-xs g-muted">Record of payment and scope, not legal advice.</footer>
        </div>
      </main>
      <div className="h-6 print:hidden" />
    </div>
  );
}
