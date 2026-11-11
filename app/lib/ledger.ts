// "Ask me" queue (batch-5 §3, fix 13) and ledger rows (§5, fix 9). Read-only; screens render these.
import type { Db } from '../db/client';
import type { PolicyResult } from './briefs';
import { scopeParts } from './format';
import type { Scope } from './pricing';
import { isDemoInvoiceId, isDemoTxnId } from './demo';

export type AskItem = {
  briefId: string;
  versionId: string;
  versionNo: number;
  client: { name: string; email: string };
  asset: { title: string };
  scope: string;
  totalCents: number;
  /** Failing rules, each in plain words with numbers ("$900.00 exceeds your $500.00 per-deal cap."). */
  failing: { rule: string; code: string; message: string }[];
  /** Approval cannot help (amount_too_small, missing_client_email): fix the deal instead. */
  hardBlock: boolean;
  sendError: string | null;
  /** Batch 8: a renewal the tick opened (shown as "Renew?"). Optional so older callers need no change. */
  renewal?: boolean;
  createdAt: Date;
};

const scopeWords = (s: Scope) => scopeParts(s).map((p) => p.label).join(', ');

/** Pending versions that failed a rule or whose send failed, newest first. */
export async function listAsk(db: Db, creatorId: string): Promise<AskItem[]> {
  const rows = await db.query<{
    id: string; brief_id: string; version_no: number; scope: Scope; total_cents: number; policy: PolicyResult | null;
    send_state: string; send_error: string | null; created_at: Date; client_name: string; client_email: string; asset_title: string; renewal_of: string | null;
  }>(
    `select v.id, v.brief_id, v.version_no, v.scope, v.total_cents, v.policy, v.send_state, v.send_error, v.created_at, v.renewal_of,
            c.name as client_name, c.email as client_email, a.title as asset_title
       from licence_versions v join clients c on c.id = v.client_id join assets a on a.id = v.asset_id
      where v.creator_id = $1 and v.status = 'pending' and v.send_state in ('idle', 'failed')
        and ((v.policy is not null and (v.policy->>'pass')::boolean = false) or v.send_state = 'failed')
      order by v.seq desc`,
    [creatorId],
  );
  return rows.map((r) => ({
    briefId: r.brief_id, versionId: r.id, versionNo: r.version_no,
    client: { name: r.client_name, email: r.client_email }, asset: { title: r.asset_title },
    scope: scopeWords(r.scope), totalCents: r.total_cents,
    failing: (r.policy?.results ?? []).filter((x) => !x.pass).map(({ rule, code, message }) => ({ rule, code, message })),
    hardBlock: r.policy?.hardBlock ?? false,
    sendError: r.send_state === 'failed' ? r.send_error : null,
    createdAt: r.created_at,
    renewal: r.renewal_of !== null,
  }));
}

export type LedgerRow = {
  eventId: string;
  kind: string;
  createdAt: Date;
  briefId: string | null;
  deal: string | null; // "Northwind Coffee · Morning Pour"
  versionId: string | null;
  versionNo: number | null;
  scope: string | null;
  rule: string | null; // R1..R5, MIN, EMAIL, or null for non-rule events
  result: 'pass' | 'fail' | null;
  message: string | null;
  paypalInvoiceId: string | null;
  invoiceNumber: string | null;
  /** Batch-6 review F22: the PayPal transaction (capture) id and amount on grant and revoke rows. */
  paypalTxnId: string | null;
  amountCents: number | null;
  /** Plain label for the event, e.g. 'Granted', 'Revoked'. */
  label: string;
  status: string | null; // invoice state when one exists, else version status
  expiry: Date | null; // licence end (set once paid, batch 6)
  renewalDate: Date | null;
  /** Batch 7: a seeded demo event (`detail.demo` or a demo invoice/transaction id). Display only, never PayPal evidence. */
  demo: boolean;
};

const LEDGER_KINDS = ['rule', 'approved', 'rejected', 'invoice.creating', 'invoice.sent', 'invoice.failed', 'invoice.cancelled',
  // batch 6
  'grant', 'revoked', 'paid_on_stale_version', 'refund_partial', 'revoked_by_parent_refund', 'txn_replay',
  // batch-6 review fixes
  'withdraw_paid', 'withdraw_failed', 'fulfillment_failed', 'refunded_before_grant', 'locked_payment_refunded',
  // batch 8: demo clock, renewals, expiry
  'clock', 'renewal.sent', 'renewal.draft', 'renewal.cancelled', 'expired'];

/** F22: what each ledger event is called on screen. A grant row that failed is 'Payment not verified'. */
export const LEDGER_LABELS: Record<string, string> = {
  rule: 'Rule', approved: 'Approved', rejected: 'Rejected', 'invoice.creating': 'Invoice started', 'invoice.sent': 'Invoice sent',
  'invoice.failed': 'Send failed', 'invoice.cancelled': 'Invoice cancelled', grant: 'Granted', revoked: 'Revoked',
  paid_on_stale_version: 'Paid on a replaced quote', refund_partial: 'Partial refund', revoked_by_parent_refund: 'Quote withdrawn',
  txn_replay: 'Payment already used', withdraw_paid: 'Withdrawn quote was paid', withdraw_failed: 'Withdrawal pending',
  fulfillment_failed: 'File not ready', refunded_before_grant: 'Refunded before unlock', locked_payment_refunded: 'Locked payment refunded',
  clock: 'Demo clock moved', 'renewal.sent': 'Renewal sent', 'renewal.draft': 'Renewal waits for you', 'renewal.cancelled': 'Renewal cancelled', expired: 'Licence expired',
};

/** Flat ledger rows for the AG Studio swap (Nov 7-8); newest first. */
export async function listLedger(db: Db, creatorId: string, limit = 500): Promise<LedgerRow[]> {
  const rows = await db.query<{
    id: string; kind: string; rule: string | null; detail: Record<string, unknown>; created_at: Date;
    v_id: string | null; version_no: number | null; scope: Scope | null; v_status: string | null; end_at: Date | null; renewal_opt_in: boolean | null;
    client_name: string | null; asset_title: string | null; i_paypal: string | null; i_number: string | null; i_state: string | null; p_amount: number | null; vp_txn: string | null; vp_amount: number | null;
  }>(
    `select e.id, e.kind, e.rule, e.detail, e.created_at,
            v.id as v_id, v.version_no, v.scope, v.status as v_status, v.end_at, v.renewal_opt_in,
            c.name as client_name, a.title as asset_title,
            i.paypal_invoice_id as i_paypal, i.invoice_number as i_number, i.state as i_state,
            pay.amount_cents as p_amount, vp.paypal_txn_id as vp_txn, vp.amount_cents as vp_amount
       from events e
       left join licence_versions v on v.id::text = e.detail->>'versionId'
       left join briefs b on b.id::text = e.detail->>'briefId'
       left join clients c on c.id = coalesce(v.client_id, b.client_id)
       left join assets a on a.id = coalesce(v.asset_id, b.asset_id)
       left join lateral (
         select paypal_invoice_id, invoice_number, state from invoices iv where iv.version_id = v.id
          and (e.detail->>'invoiceNumber' is null or iv.invoice_number = e.detail->>'invoiceNumber')
          order by iv.seq desc limit 1
       ) i on true
       left join payments pay on pay.paypal_txn_id = e.detail->>'paypalTxnId'
       -- Fix round 2 R3: a revoke row without its own transaction (older events) falls back to the version's payment.
       left join lateral (select paypal_txn_id, amount_cents from payments where version_id = v.id order by seq desc limit 1) vp on e.kind = 'revoked'
      where e.creator_id = $1 and e.kind = any($2::text[])
      order by e.created_at desc, e.seq desc
      limit $3`,
    [creatorId, LEDGER_KINDS, limit],
  );
  return rows.map((r) => {
    const d = r.detail;
    const isRule = r.kind === 'rule';
    return {
      eventId: r.id, kind: r.kind, createdAt: r.created_at,
      briefId: typeof d.briefId === 'string' ? d.briefId : null,
      deal: r.client_name && r.asset_title ? `${r.client_name} · ${r.asset_title}` : null,
      versionId: r.v_id, versionNo: r.version_no, scope: r.scope ? scopeWords(r.scope) : null,
      rule: isRule ? r.rule : null,
      result: isRule || r.kind === 'grant' ? (d.pass ? 'pass' : 'fail') : r.kind === 'revoked' || r.kind === 'txn_replay' || r.kind === 'paid_on_stale_version' ? 'fail' : r.kind === 'invoice.failed' ? 'fail' : r.kind === 'invoice.sent' || r.kind === 'approved' ? 'pass' : null,
      message: typeof d.message === 'string' ? d.message : typeof d.error === 'string' ? d.error : null,
      paypalInvoiceId: (typeof d.paypalInvoiceId === 'string' ? d.paypalInvoiceId : null) ?? r.i_paypal,
      invoiceNumber: (typeof d.invoiceNumber === 'string' ? d.invoiceNumber : null) ?? r.i_number,
      paypalTxnId: typeof d.paypalTxnId === 'string' ? d.paypalTxnId : r.vp_txn ?? null,
      amountCents: typeof d.amountCents === 'number' ? d.amountCents : r.p_amount ?? r.vp_amount ?? null,
      label: r.kind === 'grant' && !d.pass ? (typeof d.code === 'string' && d.code.startsWith('not_paid:') ? 'Checked, not paid yet' : 'Payment not verified') : LEDGER_LABELS[r.kind] ?? r.kind,
      status: r.i_state ?? r.v_status,
      expiry: r.end_at,
      renewalDate: r.end_at && r.renewal_opt_in ? r.end_at : null,
      demo: d.demo === true || isDemoInvoiceId(typeof d.paypalInvoiceId === 'string' ? d.paypalInvoiceId : r.i_paypal)
        || isDemoTxnId(typeof d.paypalTxnId === 'string' ? d.paypalTxnId : r.vp_txn),
    };
  });
}


export type AskAlert = { eventId: string; kind: string; briefId: string | null; message: string; createdAt: Date; /** Batch 7: seeded demo alert, display only. */ demo: boolean };
const ALERT_KINDS = ['paid_on_stale_version', 'refund_partial', 'revoked_by_parent_refund', 'txn_replay',
  'withdraw_paid', 'withdraw_failed', 'fulfillment_failed', 'refunded_before_grant', 'locked_payment_refunded'];

/** Batch-6 fix 4, 6, 7: payment problems a person must look at, newest first. */
export async function listAlerts(db: Db, creatorId: string, limit = 20): Promise<AskAlert[]> {
  const rows = await db.query<{ id: string; kind: string; detail: Record<string, unknown>; created_at: Date }>(
    `select id, kind, detail, created_at from events where creator_id = $1 and kind = any($2::text[]) order by created_at desc, seq desc limit $3`,
    [creatorId, ALERT_KINDS, limit]);
  return rows.map((r) => ({
    eventId: r.id, kind: r.kind, createdAt: r.created_at,
    briefId: typeof r.detail.briefId === 'string' ? r.detail.briefId : null,
    demo: r.detail.demo === true,
    message: typeof r.detail.message === 'string' ? r.detail.message : r.kind,
  }));
}
