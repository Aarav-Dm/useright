// B12 D1: the PayPal evidence for one licence version, read from what is already stored: the invoice row, the newest
// re-fetch outcome (`grant` events, written by grantIfPaid after every PayPal read) and any signature-verified webhook
// for this invoice or its capture (`webhook_events` only stores events PayPal verified). Display only.
import type { Queryable } from '../db/client';
import { isDemoInvoiceId } from './demo';

export type PaymentProof = {
  paypalInvoiceId: string;
  invoiceNumber: string;
  /** The newest PayPal re-fetch for this version and what it found, in the words grantIfPaid stored. */
  lastCheck: { at: string; pass: boolean; message: string } | null;
  /** The newest webhook for this invoice or its capture; PayPal verified its signature before it was stored. */
  webhook: { at: string; type: string } | null;
};

export async function paymentProof(q: Queryable, versionId: string): Promise<PaymentProof | null> {
  const [i] = await q.query<{ paypal_invoice_id: string | null; invoice_number: string }>(
    `select paypal_invoice_id, invoice_number from invoices where version_id = $1 order by created_at desc limit 1`, [versionId]);
  // A seeded invoice is never PayPal evidence.
  if (!i?.paypal_invoice_id || isDemoInvoiceId(i.paypal_invoice_id)) return null;
  const [g] = await q.query<{ created_at: Date; pass: boolean | null; message: string | null }>(
    `select created_at, (detail->>'pass')::boolean as pass, detail->>'message' as message from events
      where kind = 'grant' and detail->>'versionId' = $1 order by created_at desc limit 1`, [versionId]);
  const [w] = await q.query<{ received_at: Date; type: string }>(
    `select received_at, type from webhook_events
      where resource_id = $1 or resource_id in (select paypal_txn_id from payments where version_id = $2 and paypal_txn_id is not null)
      order by received_at desc limit 1`, [i.paypal_invoice_id, versionId]);
  return {
    paypalInvoiceId: i.paypal_invoice_id,
    invoiceNumber: i.invoice_number,
    lastCheck: g ? { at: new Date(g.created_at).toISOString(), pass: !!g.pass, message: g.message ?? (g.pass ? 'Paid in full.' : 'Not paid.') } : null,
    webhook: w ? { at: new Date(w.received_at).toISOString(), type: w.type } : null,
  };
}
