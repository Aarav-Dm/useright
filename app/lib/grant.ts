// grantIfPaid: the only path to `active` (batch-6 §1, §4, fixes 2-7, 15, 21; review fixes F1, F3-F5, F8, F12, F13,
// F15, F16, F21). Everything is re-fetched from PayPal; webhook bodies, the client page and the creator's button are
// only triggers.
import type { Db, Queryable } from '../db/client';
import { licensedFile, licensedKey } from './access';
import { demoMode, now as clockNow } from './clock';
import { parseCents } from './money';
import { localDay, lockCreator, zonedMidnight } from './policy';
import type { Scope } from './pricing';
import { logPayPalError, PayPalError } from './paypal/client';
import type { InvoiceApi } from './paypal/invoices';
import type { Capture, InvoiceJson, PaymentsApi } from './paypal/payments';
import { issueGrantReceipt, issueRevocationReceipt } from './receipts';
import { cancelOpenInvoice } from './send';
import { readAsset, sha256Bytes } from './storage';

export { licensedFile };

export type PayPalApis = { invoices: InvoiceApi; payments: PaymentsApi };
export type GrantDeps = { db: Db; pp: PayPalApis; uploadsDir: string; now?: () => Date };
export type GrantSource = 'webhook' | 'pay_page' | 'creator' | 'test';

// ---------- the pure check (fix 3, ports spike/invoice-check.mjs) ----------

/** PayPal's payment_date: a calendar day ("2026-10-29") or an instant. */
export type PaymentDate = { day: string } | { at: Date };

export type PaidCheck =
  | { ok: true; txnId: string; amountCents: number; paymentDate: PaymentDate | null; payerEmail: string | null }
  | { ok: false; reason: string };

/** Plain words for every refusal (fix 13); shown on the pay page and in the ledger. */
export const PAYMENT_REASONS: Record<string, string> = {
  marked_paid: 'The invoice was marked as paid by hand in PayPal. No PayPal payment was received, so the file stays locked.',
  external_record: 'PayPal records this payment as made outside PayPal (cash, cheque or bank transfer), so the file stays locked.',
  partial: 'Only part of the amount has been paid.',
  pending: 'PayPal says the payment is still pending. Check again in a few minutes.',
  not_paid: 'PayPal does not show this invoice as paid yet.',
  amount_mismatch: 'The amount paid does not match the licence price.',
  currency_mismatch: 'The payment is not in US dollars.',
  invoice_number_mismatch: 'The PayPal invoice number does not match this licence.',
  recipient_mismatch: 'The invoice was addressed to someone other than the client on this licence.',
  amount_due: 'PayPal still shows an amount due on this invoice, or the amount due could not be read.',
  no_transactions: 'PayPal shows no valid payment transaction on this invoice.',
  multiple_transactions: 'PayPal shows more than one payment on this invoice. Only a single PayPal payment unlocks automatically; the creator has been told.',
  paypal_unavailable: 'PayPal could not be reached to confirm the payment. Try again shortly.',
  txn_replay: 'This PayPal payment is already recorded against another licence.',
  stale_version: 'This quote was replaced before it was paid. The creator has been told and will sort it out.',
  refunded_before_grant: 'PayPal shows this payment was refunded or reversed, so the file stays locked.',
  refunded: 'This payment was refunded, so the licence is no longer active.',
  superseded: 'This licence was replaced by a newer one.',
  expired: 'This licence has ended.',
  file_unavailable: 'The payment is confirmed, but the file is not ready yet. The creator has been told; this page will unlock it once it is.',
  invoice_in_flight: 'The invoice is still being sent. Check again in a moment.',
  no_invoice: 'No PayPal invoice is out for this licence.',
};
export const paymentReasonWords = (code: string) => PAYMENT_REASONS[code.split(':')[0]!] ?? `Payment not verified (${code}).`;

type Money = { value?: unknown; currency_code?: unknown } | undefined | null;
const centsOf = (m: Money) => (typeof m?.value === 'string' ? parseCents(m.value) : null);
const CAPTURE_ID_RE = /^[A-Za-z0-9-]{5,64}$/;

function paymentDate(raw: unknown): PaymentDate | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) {
    const t = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
    return t.getUTCFullYear() === +m[1]! && t.getUTCMonth() === +m[2]! - 1 && t.getUTCDate() === +m[3]! ? { day: raw } : null;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : { at: d };
}

type Txn = { payment_id?: unknown; method?: unknown; payment_date?: unknown; amount?: Money; payer?: { email_address?: unknown } };

/**
 * F15: the payer as PayPal itself reports it on the transaction (`payer.email_address`), never the invoice recipient.
 * PayPal's invoice record does not always carry it; then it is unavailable (null).
 */
function payerEmailOf(t: Txn): string | null {
  const e = t.payer?.email_address;
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

export function checkInvoicePaid(inv: InvoiceJson, v: { totalCents: number; invoiceNumber: string; recipientEmail: string | null }): PaidCheck {
  const status = String(inv.status ?? '');
  if (status === 'MARKED_AS_PAID') return { ok: false, reason: 'marked_paid' };
  if (status === 'PARTIALLY_PAID') return { ok: false, reason: 'partial' };
  if (status === 'PAYMENT_PENDING') return { ok: false, reason: 'pending' };
  if (status !== 'PAID') return { ok: false, reason: `not_paid:${status || 'UNKNOWN'}` };
  const detail = (inv.detail ?? {}) as { invoice_number?: unknown; currency_code?: unknown };
  if (detail.invoice_number !== v.invoiceNumber) return { ok: false, reason: 'invoice_number_mismatch' };
  const payments = (inv.payments ?? {}) as { paid_amount?: Money; transactions?: unknown };
  // F13: the paid currency must be stated, and be USD.
  if (detail.currency_code !== 'USD' || payments.paid_amount?.currency_code !== 'USD') return { ok: false, reason: 'currency_mismatch' };
  const paid = centsOf(payments.paid_amount);
  if (paid === null || paid !== v.totalCents) return { ok: false, reason: `amount_mismatch:${paid ?? 'none'}:${v.totalCents}` };
  // F21 (review ruling): from here on the invoice number (ours, unique), PAID, USD and the exact amount all matched.
  // A missing due_amount passes; a present one must be a valid zero USD amount.
  const due = inv.due_amount as Money;
  if (due !== undefined && due !== null) {
    if (centsOf(due) !== 0) return { ok: false, reason: 'amount_due' };
    if (due.currency_code !== 'USD') return { ok: false, reason: 'currency_mismatch' };
  }
  // F21: a missing recipient email passes on the same footing; a present one must be the client's.
  const recipients = Array.isArray(inv.primary_recipients) ? (inv.primary_recipients as { billing_info?: { email_address?: unknown } }[]) : [];
  for (const rcp of recipients) {
    const to = rcp?.billing_info?.email_address;
    if (to === undefined || to === null) continue;
    if (typeof to !== 'string' || !v.recipientEmail || to.toLowerCase() !== v.recipientEmail.toLowerCase()) return { ok: false, reason: 'recipient_mismatch' };
  }
  const txs = (Array.isArray(payments.transactions) ? payments.transactions : []) as Txn[];
  if (txs.length === 0) return { ok: false, reason: 'no_transactions' };
  if (!txs.every((t) => t?.method === 'PAYPAL')) return { ok: false, reason: 'external_record' };
  // F13: B6 grants only one PayPal capture; more is refused rather than checking all and storing the first.
  if (txs.length > 1) return { ok: false, reason: 'multiple_transactions' };
  const t = txs[0]!;
  if (typeof t.payment_id !== 'string' || !CAPTURE_ID_RE.test(t.payment_id)) return { ok: false, reason: 'no_transactions' };
  if (t.amount !== undefined && t.amount !== null) {
    if (t.amount.currency_code !== 'USD') return { ok: false, reason: 'currency_mismatch' };
    const tc = centsOf(t.amount);
    if (tc !== paid) return { ok: false, reason: `amount_mismatch:${tc ?? 'none'}:${v.totalCents}` };
  }
  return { ok: true, txnId: t.payment_id, amountCents: paid, paymentDate: paymentDate(t.payment_date), payerEmail: payerEmailOf(t) };
}

// ---------- dates (F12) ----------

type Day = { y: number; m: number; d: number };

/** Licence term from a local calendar day: that day's local midnight to local midnight `months` later (day clamped to month end). */
export function termFromDay(tz: string, day: Day, months: number): { start: Date; end: Date } {
  const target = new Date(Date.UTC(day.y, day.m - 1 + months, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth() + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return { start: zonedMidnight(tz, day.y, day.m, day.d), end: zonedMidnight(tz, ty, tm, Math.min(day.d, last)) };
}

/** Licence term for a payment instant: its calendar day in the creator's timezone. */
export function licenceTerm(tz: string, paidAt: Date, months: number): { start: Date; end: Date } {
  return termFromDay(tz, localDay(tz, paidAt), months);
}

/**
 * Batch 8 §3 (the one grant change it allows): a renewal starts on the later of its payment day and the day its
 * licence ends (`renewsUntil`, a local midnight), so paying early never shortens the current term. Any other version
 * (renewsUntil null) starts on its payment day, as before. B8 review fix 5: in demo mode only, a renewal also never
 * starts before the demo clock's day (`demoDay`), so a late payment on an advanced clock is not born expired. Live mode
 * passes null and nothing changes.
 */
export function renewalStartDay(tz: string, paidDay: Day, renewsUntil: Date | null, demoDay: Day | null = null): Day {
  if (!renewsUntil) return paidDay;
  const ends = localDay(tz, renewsUntil);
  const key = (d: Day) => d.y * 10000 + d.m * 100 + d.d;
  const later = key(ends) > key(paidDay) ? ends : paidDay;
  return demoDay && key(demoDay) > key(later) ? demoDay : later;
}

/**
 * F12: the one effective payment date used for both payments.paid_at and the term. A date-only PayPal date is that
 * calendar day in the creator's timezone (stored as its local midnight); a timestamp is that instant; a missing date
 * falls back, deliberately and visibly (`source`), to the verification time.
 */
export function effectivePayment(tz: string, d: PaymentDate | null, now: Date): { at: Date; day: Day; source: 'paypal_day' | 'paypal_time' | 'verified_at' } {
  if (d && 'day' in d) {
    const [y, m, dd] = d.day.split('-').map(Number) as [number, number, number];
    return { at: zonedMidnight(tz, y, m, dd), day: { y, m, d: dd }, source: 'paypal_day' };
  }
  if (d && 'at' in d) return { at: d.at, day: localDay(tz, d.at), source: 'paypal_time' };
  return { at: now, day: localDay(tz, now), source: 'verified_at' };
}

// ---------- events ----------

async function event(q: Queryable, creatorId: string, kind: string, detail: Record<string, unknown>) {
  await q.query(`insert into events (creator_id, kind, detail) values ($1, $2, $3)`, [creatorId, kind, JSON.stringify(detail)]);
}

/** F16: one alert per (kind, evidence key). Repeated polls or duplicate events for the same evidence add nothing. */
async function alertOnce(q: Queryable, creatorId: string, kind: string, key: string, detail: Record<string, unknown>): Promise<boolean> {
  const rows = await q.query(
    `insert into events (creator_id, kind, detail)
     select $1, $2, $3 where not exists (select 1 from events where creator_id = $1 and kind = $2 and detail->>'evidenceKey' = $4)
     returning id`,
    [creatorId, kind, JSON.stringify({ ...detail, evidenceKey: key }), key]);
  return rows.length > 0;
}

// ---------- grant ----------

export type GrantResult = { granted: true; already: boolean } | { granted: false; reason: string };

type GrantRow = {
  id: string; creator_id: string; brief_id: string | null; status: string; total_cents: number; scope: Scope;
  invoice_id: string; paypal_invoice_id: string | null; invoice_number: string; invoice_state: string;
  recipient_email: string | null; client_email: string; timezone: string | null; key_web: string; key_print: string;
  locked_capture_id: string | null;
};

/** F4: also a row whose send is still in flight or whose local completion was lost (creating/created). */
async function grantRow(q: Queryable, versionId: string): Promise<GrantRow | null> {
  const [r] = await q.query<GrantRow>(
    `select v.id, v.creator_id, v.brief_id, v.status, v.total_cents, v.scope,
            i.id as invoice_id, i.paypal_invoice_id, i.invoice_number, i.state as invoice_state, i.recipient_email,
            c.email as client_email, s.timezone, a.key_web, a.key_print, v.locked_capture_id
       from licence_versions v
       join invoices i on i.version_id = v.id and i.state in ('creating', 'created', 'sent', 'paid', 'refunded')
       join clients c on c.id = v.client_id
       join assets a on a.id = v.asset_id
       left join creator_settings s on s.creator_id = v.creator_id
      where v.id = $1 order by i.seq desc limit 1`, [versionId]);
  return r ?? null;
}

const stateReason = (status: string) => (status === 'refunded' || status === 'superseded' || status === 'expired' ? status : `version_${status}`);

/**
 * grantIfPaid(versionId): GET the invoice by its stored PayPal id (fix 21), run checkInvoicePaid, hash the exact
 * licensed file (F8), then in one transaction under the creator lock (and a per-capture lock, F4): current-branch
 * check (F3), payment row, parent superseded, version pending -> active, invoice + reservation reconciled (F4),
 * receipt, event.
 */
export async function grantIfPaid(deps: GrantDeps, versionId: string, source: GrantSource): Promise<GrantResult> {
  const { db, pp } = deps;
  const r = await grantRow(db, versionId);
  if (!r) return { granted: false, reason: 'no_invoice' };
  if (!r.paypal_invoice_id) return { granted: false, reason: 'invoice_in_flight' };
  // F4: an already-recorded payment reports the version's real state; a refunded version is never "granted".
  if (r.invoice_state === 'paid' || r.invoice_state === 'refunded') {
    return r.status === 'active' ? { granted: true, already: true } : { granted: false, reason: stateReason(r.status) };
  }

  let inv: InvoiceJson;
  try {
    inv = await pp.payments.getInvoice(r.paypal_invoice_id);
  } catch (err) {
    // Spec §8: a PayPal error never grants.
    logPayPalError('grant get invoice', err);
    await db.query(`update invoices set last_checked_at = now() where id = $1`, [r.invoice_id]);
    await event(db, r.creator_id, 'grant', { briefId: r.brief_id, versionId, pass: false, code: 'paypal_unavailable', message: paymentReasonWords('paypal_unavailable'), source,
      ...(err instanceof PayPalError ? { status: err.status, debugId: err.debugId } : {}) });
    return { granted: false, reason: 'paypal_unavailable' };
  }
  await db.query(`update invoices set last_checked_at = now() where id = $1`, [r.invoice_id]);
  const check = checkInvoicePaid(inv, { totalCents: r.total_cents, invoiceNumber: r.invoice_number, recipientEmail: r.recipient_email ?? r.client_email });
  if (!check.ok) {
    // review final: paid then fully refunded before any grant: record the capture so the refund can close the quote.
    if (inv.status === 'REFUNDED' && r.status === 'pending') {
      const caps = captureIdsOf(inv);
      if (caps.length === 1) await lockQuoteCapture(db, versionId, caps[0]!);
    }
    await event(db, r.creator_id, 'grant', { briefId: r.brief_id, versionId, pass: false, code: check.reason, message: paymentReasonWords(check.reason), source, paypalStatus: String(inv.status ?? '') });
    return { granted: false, reason: check.reason };
  }

  // F8: the receipt fingerprint is the hash of the exact rendition the download serves. No guessed fallback.
  const file = licensedFile(r.scope);
  const bytes = await readAsset(deps.uploadsDir, licensedKey(file.file, r)).catch(() => null);
  const sha = bytes ? sha256Bytes(bytes) : null;
  const tz = r.timezone ?? 'America/New_York';
  const eff = effectivePayment(tz, check.paymentDate, deps.now?.() ?? new Date());

  return db.transaction(async (tx): Promise<GrantResult> => {
    // Lock order everywhere both are taken: capture, then creator (revokeFromCapture does the same).
    await tx.query(`select pg_advisory_xact_lock(hashtext('capture:' || $1))`, [check.txnId]);
    await lockCreator(tx, r.creator_id);
    const [v] = await tx.query<{ status: string; parent_id: string | null; client_id: string; asset_id: string; version_no: number; withdrawn_at: Date | null; renewal_of: string | null }>(
      `select status, parent_id, client_id, asset_id, version_no, withdrawn_at, renewal_of from licence_versions where id = $1 for update`, [versionId]);
    const [seen] = await tx.query<{ version_id: string }>(`select version_id from payments where paypal_txn_id = $1`, [check.txnId]);
    if (seen) {
      if (seen.version_id === versionId) return v?.status === 'active' ? { granted: true, already: true } : { granted: false, reason: stateReason(v?.status ?? 'missing') };
      await event(tx, r.creator_id, 'txn_replay', { briefId: r.brief_id, versionId, paypalTxnId: check.txnId, message: paymentReasonWords('txn_replay') });
      return { granted: false, reason: 'txn_replay' };
    }
    // F4: PayPal already told us (webhook before the mapping existed) that this capture was refunded or reversed.
    const [rev] = await tx.query<{ status: string }>(`select status from capture_reversals where capture_id = $1`, [check.txnId]);
    if (rev && FULL.has(rev.status)) {
      await tx.query(`update capture_reversals set resolved_at = coalesce(resolved_at, now()) where capture_id = $1`, [check.txnId]);
      // Fix round 2 (review major 1): PayPal shows this money refunded, so the quote is finished, not stuck pending.
      await tx.query(`update licence_versions set locked_capture_id = coalesce(locked_capture_id, $2) where id = $1 and status = 'pending'`, [versionId, check.txnId]);
      await closeLockedQuote(tx, r.creator_id, versionId, check.txnId, rev.status);
      await alertOnce(tx, r.creator_id, 'refunded_before_grant', `refunded_before_grant:${check.txnId}`, {
        briefId: r.brief_id, versionId, paypalTxnId: check.txnId, amountCents: check.amountCents, captureStatus: rev.status,
        message: `PayPal reported this payment ${rev.status.toLowerCase()} before it was recorded. Nothing was unlocked.`,
      });
      return { granted: false, reason: 'refunded_before_grant' };
    }

    // Fix 4 + F1 + F3: money for a quote that is no longer the open quote on the current branch unlocks nothing.
    let stale: string | null = !v || v.status !== 'pending' ? `it is now ${v?.status ?? 'missing'}`
      : v.withdrawn_at ? 'the licence it built on was refunded' : null;
    let parentPaid = 0;
    let renewsUntil: Date | null = null;
    if (!stale && v) {
      const actives = await tx.query<{ id: string }>(
        `select id from licence_versions where client_id = $1 and asset_id = $2 and status = 'active' and id <> $3`, [v.client_id, v.asset_id, versionId]);
      if (v.parent_id) {
        const [p] = await tx.query<{ status: string; paid_cents: number; end_at: Date | null }>(`select status, paid_cents, end_at from licence_versions where id = $1 for update`, [v.parent_id]);
        // Batch 8 plan fix 1: a renewal may also be paid after its licence expired; refunded or superseded still refuse.
        const parentOk = p && (p.status === 'active' || (v.renewal_of !== null && p.status === 'expired'));
        if (!p || !parentOk) stale = `the licence it extends is ${p?.status ?? 'missing'}`;
        else if (actives.some((a) => a.id !== v.parent_id)) stale = 'another licence is current';
        else if (v.renewal_of !== null) renewsUntil = p.end_at; // a renewal is paid for its own new term only
        else parentPaid = p.paid_cents;
      } else if (actives.length > 0) {
        stale = 'another licence is already current';
      }
    }
    if (stale) {
      // Fix round 2 (review major 1): remember the capture this locked quote holds, so its refund can close the quote.
      if (v?.status === 'pending') await tx.query(`update licence_versions set locked_capture_id = coalesce(locked_capture_id, $2) where id = $1`, [versionId, check.txnId]);
      await alertOnce(tx, r.creator_id, 'paid_on_stale_version', `stale:${check.txnId}`, {
        briefId: r.brief_id, versionId, versionStatus: v?.status ?? null, paypalTxnId: check.txnId, amountCents: check.amountCents,
        message: `A client paid a quote that is no longer open (${stale}). Nothing was unlocked. Refund it in PayPal or re-issue the licence.`,
      });
      return { granted: false, reason: 'stale_version' };
    }
    if (!sha) {
      await alertOnce(tx, r.creator_id, 'fulfillment_failed', `file:${versionId}`, {
        briefId: r.brief_id, versionId, paypalTxnId: check.txnId, amountCents: check.amountCents,
        message: `PayPal confirmed payment, but the ${file.label.toLowerCase()} could not be read. Nothing was unlocked yet; restore the file and Re-check PayPal.`,
      });
      await event(tx, r.creator_id, 'grant', { briefId: r.brief_id, versionId, pass: false, code: 'file_unavailable', message: paymentReasonWords('file_unavailable'), source });
      return { granted: false, reason: 'file_unavailable' };
    }

    // F3: version numbers stay unique among licences that were ever granted for this client + photo.
    let versionNo = v!.version_no;
    if (v!.parent_id) {
      const [{ clash, max }] = (await tx.query<{ clash: boolean; max: number }>(
        `select bool_or(version_no = $4) as clash, coalesce(max(version_no), 0)::int as max from licence_versions
          where client_id = $1 and asset_id = $2 and id <> $3 and status in ('active', 'superseded', 'expired', 'refunded')`,
        [v!.client_id, v!.asset_id, versionId, versionNo])) as [{ clash: boolean | null; max: number }];
      if (clash) versionNo = max + 1;
    }
    // B8 review fix 5: the real PayPal payment time (eff.at) stays the stored evidence; only the renewal term reads the
    // demo clock, and only in demo mode.
    const demoDay = renewsUntil && demoMode() ? localDay(tz, await clockNow(tx, process.env, () => (deps.now?.() ?? new Date()).getTime())) : null;
    const term = termFromDay(tz, renewalStartDay(tz, eff.day, renewsUntil, demoDay), r.scope.durationMonths);
    // F3: the parent leaves the current branch first; the one-active index is the database backstop.
    if (v!.parent_id) await tx.query(`update licence_versions set status = 'superseded' where id = $1 and status = 'active'`, [v!.parent_id]);
    const [upd] = await tx.query<{ id: string }>(
      `update licence_versions set status = 'active', start_at = $2, end_at = $3, paid_cents = $4, version_no = $5,
              rail = 'invoice', send_state = 'sent', send_error = null
        where id = $1 and status = 'pending' returning id`,
      [versionId, term.start, term.end, parentPaid + check.amountCents, versionNo]);
    if (!upd) throw new Error('grant: version changed under the lock');
    await tx.query(
      `insert into payments (creator_id, version_id, paypal_txn_id, amount_cents, currency, payer_email, paid_at) values ($1, $2, $3, $4, 'USD', $5, $6)`,
      [r.creator_id, versionId, check.txnId, check.amountCents, check.payerEmail, eff.at]);
    // F4: a send whose local completion was lost (or is still running) is reconciled here, with its R3 reservation.
    await tx.query(`update invoices set state = 'paid', sent_at = coalesce(sent_at, now()), error = null where id = $1 and state in ('creating', 'created', 'sent')`, [r.invoice_id]);
    await tx.query(
      `update autopilot_sends set status = 'sent', sent_at = coalesce(sent_at, now()) where id = (
         select id from autopilot_sends where version_id = $1 and status in ('reserved', 'released')
          order by (status = 'reserved') desc, seq desc limit 1)
         and not exists (select 1 from autopilot_sends where version_id = $1 and status = 'sent')`, [versionId]);
    const receipt = await issueGrantReceipt(tx, {
      versionId, txnId: check.txnId, amountCents: check.amountCents, fileSha256: sha, paypalInvoiceId: r.paypal_invoice_id!, invoiceNumber: r.invoice_number, payerEmail: check.payerEmail,
    });
    if (rev?.status === 'PARTIALLY_REFUNDED') {
      await partialAlert(tx, r.creator_id, check.txnId, null, { briefId: r.brief_id, versionId, source });
    }
    await event(tx, r.creator_id, 'grant', {
      briefId: r.brief_id, versionId, pass: true, code: 'paid', source, paypalTxnId: check.txnId, amountCents: check.amountCents,
      receiptId: receipt.publicId, invoiceNumber: r.invoice_number, paypalInvoiceId: r.paypal_invoice_id, paymentDateSource: eff.source,
      ...(r.invoice_state !== 'sent' ? { reconciledInvoiceState: r.invoice_state } : {}),
      message: `Verified with PayPal: paid in full, transaction ${check.txnId}.`,
    });
    return { granted: true, already: false };
  });
}

// ---------- revocation (§4, fixes 5, 6, 7; F1, F4, F16) ----------

export type RevokeResult = { revoked: boolean; reason: string; versions?: string[]; cleanupIncomplete?: boolean };

const FULL = new Set(['REFUNDED', 'REVERSED']);

/** What one fetched capture means for the version it paid. */
async function applyCapture(deps: GrantDeps, p: { version_id: string; creator_id: string }, captureId: string, cap: Capture, source: GrantSource, evidence: string | null): Promise<RevokeResult> {
  if (FULL.has(cap.status)) return revokeVersion(deps, p.version_id, { captureId, captureStatus: cap.status, source });
  if (cap.status === 'PARTIALLY_REFUNDED') {
    const [v] = await deps.db.query<{ brief_id: string | null }>(`select brief_id from licence_versions where id = $1`, [p.version_id]);
    await deps.db.transaction(async (tx) => {
      await lockCreator(tx, p.creator_id);
      await partialAlert(tx, p.creator_id, captureId, evidence, { briefId: v?.brief_id ?? null, versionId: p.version_id, source });
    });
    return { revoked: false, reason: 'partial' };
  }
  return { revoked: false, reason: `capture_${cap.status || 'unknown'}` };
}

/**
 * F16: one alert per piece of partial-refund evidence. A webhook names the refund (`evidence` = refund id); a
 * Re-check or the grant only sees the capture status (`evidence` = null). Without a refund id, nothing is added when
 * any alert for the capture exists; a refund id already alerted, or first seen after a status-only alert, adds nothing.
 */
async function partialAlert(tx: Queryable, creatorId: string, captureId: string, evidence: string | null, detail: Record<string, unknown>): Promise<void> {
  const keys = (await tx.query<{ k: string }>(
    `select detail->>'evidenceKey' as k from events where creator_id = $1 and kind = 'refund_partial' and detail->>'paypalTxnId' = $2`, [creatorId, captureId])).map((r) => r.k);
  const statusOnly = `partial:${captureId}:status`;
  if (evidence === null && keys.length > 0) return;
  if (evidence !== null && (keys.includes(`partial:${captureId}:${evidence}`) || (keys.length > 0 && keys.every((k) => k === statusOnly)))) {
    if (keys.every((k) => k === statusOnly)) {
      // Adopt the status-only alert as this refund's, so a different later refund still alerts.
      await tx.query(`update events set detail = jsonb_set(detail, '{evidenceKey}', to_jsonb($3::text)) where creator_id = $1 and kind = 'refund_partial' and detail->>'evidenceKey' = $2`,
        [creatorId, statusOnly, `partial:${captureId}:${evidence}`]);
    }
    return;
  }
  await alertOnce(tx, creatorId, 'refund_partial', evidence === null ? statusOnly : `partial:${captureId}:${evidence}`, {
    ...detail, paypalTxnId: captureId,
    message: `Part of payment ${captureId} was refunded in PayPal. The licence stays active; decide in PayPal whether to refund the rest.`,
  });
}

/**
 * Revokes the version paid by this capture, only when PayPal's capture is fully REFUNDED or REVERSED (fix 6).
 * `captureId` comes from the event (refund: links[rel=up]; reversal: resource.id); payments.paypal_txn_id maps it (fix 5).
 * F4: from a webhook, an unmapped capture is re-fetched and, when PayPal knows it, kept in capture_reversals so a grant
 * that commits later sees it. Throws when PayPal cannot be asked (the webhook answers 503 and PayPal retries).
 */
export async function revokeFromCapture(deps: GrantDeps, captureId: string, source: GrantSource, opts: { evidence?: string | null; eventId?: string | null; unmapped?: boolean } = {}): Promise<RevokeResult> {
  const mapped = () => deps.db.query<{ version_id: string; creator_id: string }>(`select version_id, creator_id from payments where paypal_txn_id = $1`, [captureId]).then((r) => r[0] ?? null);
  let p = await mapped();
  if (!p && source !== 'webhook' && !opts.unmapped) return { revoked: false, reason: 'unmapped' };
  const fetchCapture = () => deps.pp.payments.getCapture(captureId);
  if (!p) {
    // Fix round 2 R1 + review: on the unmapped path the capture is read while holding the per-capture lock, so two
    // handlers' PayPal reads and writes are ordered together. grantIfPaid takes the same lock first.
    const stored = await deps.db.transaction(async (tx): Promise<{ reason: string } | null> => {
      await tx.query(`select pg_advisory_xact_lock(hashtext('capture:' || $1))`, [captureId]);
      const [now] = await tx.query(`select 1 from payments where paypal_txn_id = $1`, [captureId]);
      if (now) return null;
      let cap: Capture;
      try {
        cap = await fetchCapture();
      } catch (err) {
        if (err instanceof PayPalError && err.status === 404) return { reason: 'unmapped' }; // not a capture PayPal knows
        throw err;
      }
      // Full refund/reversal evidence is final: a weaker status never replaces it.
      const [kept] = await tx.query<{ status: string }>(
        `insert into capture_reversals (capture_id, status, event_id) values ($1, $2, $3)
         on conflict (capture_id) do update set
           status = case when capture_reversals.status in ('REFUNDED', 'REVERSED') then capture_reversals.status else excluded.status end,
           event_id = coalesce(excluded.event_id, capture_reversals.event_id), received_at = now()
         returning status`,
        [captureId, cap.status, opts.eventId ?? null]);
      // Fix round 2 (review major 1): a quote that holds this capture but was never granted is closed by a full refund.
      const [locked] = await tx.query<{ id: string; creator_id: string; brief_id: string | null }>(
        `select id, creator_id, brief_id from licence_versions where locked_capture_id = $1 and status = 'pending'`, [captureId]);
      if (locked) {
        await lockCreator(tx, locked.creator_id);
        if (FULL.has(kept!.status)) {
          await closeLockedQuote(tx, locked.creator_id, locked.id, captureId, kept!.status);
          return { reason: 'locked_closed' };
        }
        if (cap.status === 'PARTIALLY_REFUNDED') {
          await partialAlert(tx, locked.creator_id, captureId, opts.evidence ?? null, { briefId: locked.brief_id, versionId: locked.id, source });
          return { reason: 'partial' };
        }
      }
      return { reason: 'stored_unmapped' };
    });
    if (stored) return { revoked: false, reason: stored.reason };
    p = await mapped(); // the payment committed meanwhile: handle it now
    if (!p) return { revoked: false, reason: 'unmapped' };
  }
  // Mapped: the payment row is the evidence and revocation is one-way (refunded never returns to active).
  const cap = await fetchCapture(); // throws: caller records the failure, PayPal retries
  return applyCapture(deps, p, captureId, cap, source, opts.evidence ?? null);
}

/**
 * Fix round 2 (review major 1): the terminal step for a quote PayPal shows paid that was never unlocked (stale branch,
 * withdrawn after a parent refund, or refunded before grant): once PayPal shows that payment fully refunded or
 * reversed, the quote is closed (superseded), its invoice recorded as refunded and its reservation released, so the
 * deal can be re-quoted. Run under the creator lock.
 */
async function closeLockedQuote(tx: Queryable, creatorId: string, versionId: string, captureId: string, captureStatus: string): Promise<boolean> {
  const [v] = await tx.query<{ brief_id: string | null }>(
    `update licence_versions set status = 'superseded', withdraw_state = 'refunded', send_state = 'idle' where id = $1 and status = 'pending' returning brief_id`, [versionId]);
  if (!v) return false;
  await tx.query(`update invoices set state = 'refunded' where version_id = $1 and state in ('creating', 'created', 'sent')`, [versionId]);
  await tx.query(`update autopilot_sends set status = 'released' where version_id = $1 and status = 'reserved'`, [versionId]);
  await event(tx, creatorId, 'locked_payment_refunded', { versionId, briefId: v.brief_id, paypalTxnId: captureId, captureStatus,
    message: `The payment for a quote that was never unlocked was ${captureStatus === 'REVERSED' ? 'reversed' : 'refunded'} in PayPal. The quote is closed; edit the deal to re-quote.` });
  return true;
}

type Descendant = { id: string; status: string; brief_id: string | null };

/**
 * The version and every version built on it (parent_id chain) that was granted -> refunded; their download tokens
 * voided; a revocation receipt each; the parent goes back to active if it is still in term (fix 7). F1: pending quotes
 * built on it are withdrawn at once under the lock (ineligible for grant), then their PayPal invoices are cancelled;
 * unfinished cancellation is retried on every later call, including when the version is already refunded.
 */
export async function revokeVersion(deps: GrantDeps, versionId: string, detail: { captureId?: string; captureStatus?: string; source: GrantSource }): Promise<RevokeResult> {
  const { db } = deps;
  const [head] = await db.query<{ creator_id: string }>(`select creator_id from licence_versions where id = $1`, [versionId]);
  if (!head) return { revoked: false, reason: 'unmapped' };
  const out = await db.transaction(async (tx) => {
    await lockCreator(tx, head.creator_id);
    const [v] = await tx.query<{ id: string; status: string; client_id: string; asset_id: string; parent_id: string | null; brief_id: string | null }>(
      `select id, status, client_id, asset_id, parent_id, brief_id from licence_versions where id = $1 for update`, [versionId]);
    if (!v) return null;
    const desc = await tx.query<Descendant>(
      `with recursive d as (
         select id, status::text as status, brief_id from licence_versions where parent_id = $1
         union all
         select c.id, c.status::text, c.brief_id from licence_versions c join d on c.parent_id = d.id
       ) select id, status, brief_id from d`, [v.id]);
    const pending = desc.filter((d) => d.status === 'pending').map((d) => d.id);
    // F1: before any PayPal call, a quote built on refunded credit can no longer be granted. Fix round 2 (review #3): this
    // also runs when the root was already refunded (for example before migration 007), so its children are withdrawn.
    if (pending.length) await tx.query(`update licence_versions set withdrawn_at = now() where id = any($1::uuid[]) and withdrawn_at is null`, [pending]);
    // Already refunded: nothing to revoke again, but its unfinished withdrawals are retried below (F1).
    if (v.status === 'refunded') {
      await recordOwnRefundAfterCascade(tx, head.creator_id, v, detail);
      return { targets: null, pending };
    }
    const granted = desc.filter((d) => d.status === 'active' || d.status === 'superseded' || d.status === 'expired');
    const targets = [v.id, ...granted.map((d) => d.id)];
    await tx.query(`update licence_versions set status = 'refunded' where id = any($1::uuid[])`, [targets]);
    await tx.query(`update invoices set state = 'refunded' where version_id = any($1::uuid[]) and state = 'paid'`, [targets]);
    await tx.query(`update download_tokens set voided_at = now() where version_id = any($1::uuid[]) and voided_at is null`, [targets]);
    if (v.parent_id) {
      // B8 review fix 5: in demo mode a parent whose term is over on the demo clock is not restored (live: real now()).
      const demoNow = demoMode() ? await clockNow(tx, process.env, () => (deps.now?.() ?? new Date()).getTime()) : null;
      await tx.query(
        `update licence_versions p set status = 'active' where p.id = $1 and p.status = 'superseded' and p.end_at > coalesce($2::timestamptz, now())
           and not exists (select 1 from licence_versions o where o.client_id = p.client_id and o.asset_id = p.asset_id and o.status = 'active')`, [v.parent_id, demoNow]);
    }
    for (const id of targets) {
      await issueRevocationReceipt(tx, id, detail.captureStatus === 'REVERSED' ? 'Payment reversed in PayPal' : 'Payment refunded in PayPal');
      // Fix round 2 R3: each revoked version names the PayPal payment that bought it; a cascaded one also names the
      // refunded capture that caused it.
      const [own] = await tx.query<{ paypal_txn_id: string; amount_cents: number }>(
        `select paypal_txn_id, amount_cents from payments where version_id = $1 order by seq desc limit 1`, [id]);
      await event(tx, head.creator_id, 'revoked', {
        versionId: id, briefId: id === v.id ? v.brief_id : granted.find((l) => l.id === id)?.brief_id ?? null, source: detail.source,
        paypalTxnId: own?.paypal_txn_id ?? (id === v.id ? detail.captureId ?? null : null), captureStatus: detail.captureStatus ?? null, amountCents: own?.amount_cents ?? null,
        ...(id !== v.id ? { causedByTxnId: detail.captureId ?? null } : {}),
        message: id === v.id ? 'Payment refunded in PayPal; licence revoked and downloads stopped.' : 'Revoked because an earlier licence it built on was refunded.',
      });
    }
    return { targets, pending };
  });
  if (!out) return { revoked: false, reason: 'unmapped' };
  const cleanup = await withdrawPending(deps, head.creator_id, out.pending);
  if (!out.targets) return { revoked: false, reason: 'already_refunded', cleanupIncomplete: cleanup.incomplete };
  return { revoked: true, reason: 'refunded', versions: out.targets, cleanupIncomplete: cleanup.incomplete };
}

/**
 * review B7C final N4 (approved lib change, this case only): a version revoked only because an earlier licence it built on
 * was refunded keeps its own money, until PayPal refunds that version's own payment too. That second refund changes no
 * status (the licence is already revoked) and issues no new receipt; it is recorded as one `revoked` event without
 * `causedByTxnId`, so the money reads move it to Refunded. Recorded once: a replayed webhook, a recheck, or a version
 * whose own refund is already on record adds nothing. Runs inside revokeVersion's creator lock.
 */
async function recordOwnRefundAfterCascade(
  tx: Queryable, creatorId: string, v: { id: string; brief_id: string | null },
  detail: { captureId?: string; captureStatus?: string; source: GrantSource },
): Promise<void> {
  if (!detail.captureId) return;
  const [own] = await tx.query<{ paypal_txn_id: string; amount_cents: number }>(
    `select paypal_txn_id, amount_cents from payments where version_id = $1 order by seq desc limit 1`, [v.id]);
  if (!own || own.paypal_txn_id !== detail.captureId) return; // not this version's own payment
  const [cascaded] = await tx.query(
    `select 1 from events where creator_id = $1 and kind = 'revoked' and detail->>'versionId' = $2 and detail ? 'causedByTxnId'`, [creatorId, v.id]);
  if (!cascaded) return; // refunded as itself already: the existing revoked row says so
  const [recorded] = await tx.query(
    `select 1 from events where creator_id = $1 and kind = 'revoked' and detail->>'versionId' = $2 and not (detail ? 'causedByTxnId')`, [creatorId, v.id]);
  if (recorded) return;
  await event(tx, creatorId, 'revoked', {
    versionId: v.id, briefId: v.brief_id, source: detail.source, paypalTxnId: own.paypal_txn_id, captureStatus: detail.captureStatus ?? null,
    amountCents: own.amount_cents, ownRefundAfterCascade: true,
    message: 'Payment refunded in PayPal; this licence was already revoked after an earlier licence was refunded.',
  });
}

/**
 * F1: finishes the withdrawal of every quote marked withdrawn (built on a refunded licence); `only` limits it to
 * some versions. No invoice -> withdrawn now. A live invoice -> cancelled at PayPal first (reservation released only
 * once PayPal confirms). PayPal shows a payment -> stays locked with a creator alert. Any other failure leaves the
 * work recorded and reports incomplete.
 */
export async function withdrawPending(deps: GrantDeps, creatorId: string, only?: string[]): Promise<{ incomplete: boolean }> {
  const { db } = deps;
  if (only && only.length === 0) return { incomplete: false };
  const rows = await db.query<{ id: string; brief_id: string | null }>(
    `select id, brief_id from licence_versions where creator_id = $1 and status = 'pending' and withdrawn_at is not null and withdraw_state is null
        and ($2::uuid[] is null or id = any($2::uuid[])) order by seq`,
    [creatorId, only ?? null]);
  let incomplete = false;
  const withdrawn = (tx: Queryable, id: string, briefId: string | null) => event(tx, creatorId, 'revoked_by_parent_refund', { versionId: id, briefId,
    message: 'This quote was withdrawn because the licence it built on was refunded. Re-quote the deal.' });
  for (const p of rows) {
    const [live] = await db.query(`select 1 from invoices where version_id = $1 and state <> 'cancelled'`, [p.id]);
    if (!live) {
      await withdrawLocally(db, creatorId, p, withdrawn);
      continue;
    }
    // Fix round 2 (review #4): cancelled by the version's own invoice, so a quote without a brief is cancelled too.
    const c = await cancelOpenInvoice(db, deps.pp.invoices, creatorId, { versionId: p.id })
      .catch((e: unknown): { ok: false; code: string } => { logPayPalError('cancel after refund', e); return { ok: false, code: 'cancel_failed' }; });
    if (!c.ok && c.code === 'no_invoice') {
      // review #7: another runner cancelled it meanwhile; finish locally, once.
      await withdrawLocally(db, creatorId, p, withdrawn);
      continue;
    }
    let lockedCapture: string | null = null;
    if (!c.ok && c.code === 'already_paid') lockedCapture = await paidCaptureOf(deps, p.id);
    await db.transaction(async (tx) => {
      await lockCreator(tx, creatorId);
      if (c.ok) {
        // review #7: guarded, so a second runner never logs a second "withdrawn".
        const [done] = await tx.query(`update licence_versions set withdraw_state = 'done' where id = $1 and withdraw_state is null returning id`, [p.id]);
        if (done) await withdrawn(tx, p.id, p.brief_id);
      } else if (c.code === 'already_paid' && lockedCapture) {
        // review major 1: only PAID / PARTIALLY_PAID. The capture is kept so its refund can close the quote.
        await tx.query(`update licence_versions set withdraw_state = 'paid', locked_capture_id = coalesce(locked_capture_id, $2) where id = $1 and withdraw_state is null`, [p.id, lockedCapture]);
        await alertOnce(tx, creatorId, 'withdraw_paid', `withdraw_paid:${p.id}`, { versionId: p.id, briefId: p.brief_id, paypalTxnId: lockedCapture,
          message: 'The client paid a quote built on a licence that was refunded. It stays locked; refund it in PayPal (that closes the quote) or re-issue the licence.' });
      } else if (c.code === 'marked_paid') {
        // No PayPal money: the creator must remove the manual mark in PayPal. Not a transient failure, so a
        // webhook is not told to retry; the next refund event or creator Re-check tries again.
        await alertOnce(tx, creatorId, 'withdraw_failed', `withdraw_marked:${p.id}`, { versionId: p.id, briefId: p.brief_id,
          message: 'A quote built on a refunded licence is marked as paid by hand in PayPal, so it cannot be cancelled. Remove the mark in PayPal, then Re-check PayPal. It stays locked.' });
      } else {
        // cancel_failed, payment_pending (PAYMENT_PENDING may still settle), a send in flight, or (review round-2
        // pre-review) PAID but its capture id could not be read yet: without it no refund could ever close the
        // quote, so withdraw_state stays null and the next refund event or Re-check tries again.
        incomplete = true;
        await alertOnce(tx, creatorId, 'withdraw_failed', `withdraw_failed:${p.id}`, { versionId: p.id, briefId: p.brief_id,
          message: c.code === 'payment_pending'
            ? 'A quote built on a refunded licence has a PayPal payment still pending. It is locked; it will be checked again.'
            : c.code === 'already_paid'
              ? 'The client paid a quote built on a refunded licence, but PayPal could not be read to record the payment. It is locked and will be checked again.'
              : 'A quote built on a refunded licence could not be cancelled in PayPal yet. It is locked and will be retried.' });
      }
    });
  }
  return { incomplete };
}

type WithdrawRow = { id: string; brief_id: string | null };

/** No live invoice: the withdrawn quote is closed here and its reservation released. Guarded, so it happens once. */
async function withdrawLocally(db: Db, creatorId: string, p: WithdrawRow, withdrawn: (tx: Queryable, id: string, briefId: string | null) => Promise<void>) {
  await db.transaction(async (tx) => {
    await lockCreator(tx, creatorId);
    const [done] = await tx.query(`update licence_versions set status = 'superseded', withdraw_state = 'done' where id = $1 and status = 'pending' and withdraw_state is null returning id`, [p.id]);
    if (!done) return;
    await tx.query(`update autopilot_sends set status = 'released' where version_id = $1 and status = 'reserved'`, [p.id]);
    await withdrawn(tx, p.id, p.brief_id);
  });
}

/** The PayPal capture on a paid invoice of this version, or null when PayPal cannot be read. */
async function paidCaptureOf(deps: GrantDeps, versionId: string): Promise<string | null> {
  const [i] = await deps.db.query<{ paypal_invoice_id: string | null }>(
    `select paypal_invoice_id from invoices where version_id = $1 and state <> 'cancelled' order by seq desc limit 1`, [versionId]);
  if (!i?.paypal_invoice_id) return null;
  try {
    return captureIdsOf(await deps.pp.payments.getInvoice(i.paypal_invoice_id))[0] ?? null;
  } catch (err) {
    logPayPalError('read paid capture', err);
    return null;
  }
}

/**
 * review final (5bae423 check new #1): a still-pending quote whose invoice PayPal shows paid and refunded (no grant was
 * ever attempted, so no capture was recorded) gets that capture recorded, so the refund closes it via closeLockedQuote.
 * Never touches a granted version.
 */
export async function lockQuoteCapture(db: Queryable, versionId: string, captureId: string): Promise<void> {
  await db.query(`update licence_versions set locked_capture_id = $2 where id = $1 and status = 'pending' and locked_capture_id is null`, [versionId, captureId]);
}

/** PayPal capture ids of an invoice's PAYPAL transactions. */
export function captureIdsOf(inv: InvoiceJson): string[] {
  const txs = ((inv.payments ?? {}) as { transactions?: unknown }).transactions;
  return (Array.isArray(txs) ? txs as Txn[] : [])
    .filter((t) => t?.method === 'PAYPAL' && typeof t.payment_id === 'string' && CAPTURE_ID_RE.test(t.payment_id))
    .map((t) => t.payment_id as string);
}

// ---------- re-check (§2 client page + creator button, fixes 10, 15; F5, F14) ----------

export const PAY_PAGE_CHECK_MS = 10_000;

export type RecheckOutcome = 'granted' | 'already' | 'refused' | 'revoked' | 'partial' | 'unchanged' | 'unavailable';
export type RecheckResult =
  | { checked: false; reason: 'throttled' | 'nothing_to_check' }
  | { checked: true; outcome: RecheckOutcome; message: string; grant?: GrantResult; revoke?: RevokeResult };

const OUTCOME_WORDS: Record<Exclude<RecheckOutcome, 'refused'>, string> = {
  granted: 'PayPal confirmed the payment. The file is unlocked and a rights receipt was issued.',
  already: 'Already verified with PayPal. Nothing changed.',
  revoked: 'PayPal shows the payment was refunded or reversed. The licence is revoked and downloads are stopped.',
  partial: 'PayPal shows a partial refund. The licence stays active; see the alert in Ask me.',
  unchanged: 'Checked with PayPal: the payment is still in place. Nothing changed.',
  unavailable: 'PayPal could not be reached, so nothing was changed. Try again shortly.',
};

/** Seeded demo payments are not PayPal captures and are never fetched. */
const isSeedTxn = (id: string) => id.startsWith('SEED-');

/**
 * Pending -> grantIfPaid. Active or superseded (F5) -> GET every recorded capture of this version and of the licences
 * it built on; a full refund/reversal revokes that version and its descendants, a partial one alerts, an unreadable
 * capture reports `unavailable` and changes nothing. `throttleMs`: at most one PayPal round per invoice per window.
 */
export async function recheck(deps: GrantDeps, versionId: string, source: GrantSource, throttleMs = 0): Promise<RecheckResult> {
  const { db } = deps;
  const r = await grantRow(db, versionId);
  // Fix round 2 (review #6): the creator's button retries unfinished withdrawals even when there is nothing to check.
  if (source === 'creator') {
    const creator = r?.creator_id ?? (await db.query<{ creator_id: string }>(`select creator_id from licence_versions where id = $1`, [versionId]))[0]?.creator_id;
    if (creator) await withdrawPending(deps, creator);
  }
  if (!r || !r.paypal_invoice_id || !['pending', 'active', 'superseded'].includes(r.status)) return { checked: false, reason: 'nothing_to_check' };
  if (throttleMs > 0) {
    const [slot] = await db.query(
      `update invoices set last_checked_at = now() where id = $1 and (last_checked_at is null or last_checked_at < $2) returning id`,
      [r.invoice_id, new Date(Date.now() - throttleMs)]);
    if (!slot) return { checked: false, reason: 'throttled' };
  }
  // Fix round 2 (review major 1): a paid quote that could not be unlocked closes once PayPal shows the money returned.
  const closeLocked = async (captureId: string): Promise<RecheckResult | null> => {
    let cap: Capture;
    try {
      cap = await deps.pp.payments.getCapture(captureId);
    } catch (err) {
      logPayPalError('recheck locked capture', err);
      return { checked: true, outcome: 'unavailable', message: OUTCOME_WORDS.unavailable };
    }
    if (!FULL.has(cap.status)) return null;
    const res = await revokeFromCapture(deps, captureId, source, { unmapped: true });
    return res.reason === 'locked_closed' ? { checked: true, outcome: 'revoked', message: 'PayPal shows this locked payment was refunded. The quote is closed; edit the deal to re-quote.', revoke: res } : null;
  };
  if (r.status === 'pending' && r.locked_capture_id) {
    const closed = await closeLocked(r.locked_capture_id);
    if (closed) return closed;
  }
  if (r.status === 'pending') {
    const grant = await grantIfPaid(deps, versionId, source);
    if (grant.granted) return { checked: true, outcome: grant.already ? 'already' : 'granted', message: OUTCOME_WORDS[grant.already ? 'already' : 'granted'], grant };
    if (grant.reason === 'not_paid:REFUNDED' && !r.locked_capture_id) {
      // review final: grantIfPaid just recorded the refunded invoice's capture; close the quote now.
      const [lc] = await db.query<{ locked_capture_id: string | null }>(`select locked_capture_id from licence_versions where id = $1`, [versionId]);
      const closed = lc?.locked_capture_id ? await closeLocked(lc.locked_capture_id) : null;
      if (closed) return closed;
    }
    const outcome = grant.reason === 'paypal_unavailable' ? 'unavailable' : 'refused';
    return { checked: true, outcome, message: outcome === 'unavailable' ? OUTCOME_WORDS.unavailable : paymentReasonWords(grant.reason), grant };
  }
  const caps = await db.query<{ paypal_txn_id: string; version_id: string; creator_id: string }>(
    `with recursive up as (
       select id, parent_id, version_no from licence_versions where id = $1
       union all
       select p.id, p.parent_id, p.version_no from licence_versions p join up on p.id = up.parent_id
     ) select pay.paypal_txn_id, pay.version_id, pay.creator_id from up
         join licence_versions v on v.id = up.id and v.status in ('active', 'superseded')
         join payments pay on pay.version_id = up.id
        order by up.version_no, pay.seq`, [versionId]);
  let unavailable = false;
  let partial = false;
  for (const c of caps) {
    if (isSeedTxn(c.paypal_txn_id)) continue;
    let cap: Capture;
    try {
      cap = await deps.pp.payments.getCapture(c.paypal_txn_id);
    } catch (err) {
      logPayPalError('recheck capture', err);
      unavailable = true;
      continue;
    }
    const res = await applyCapture(deps, c, c.paypal_txn_id, cap, source, null);
    if (res.revoked || res.reason === 'already_refunded') return { checked: true, outcome: 'revoked', message: OUTCOME_WORDS.revoked, revoke: res };
    if (res.reason === 'partial') partial = true;
  }
  const outcome: RecheckOutcome = unavailable ? 'unavailable' : partial ? 'partial' : 'unchanged';
  return { checked: true, outcome, message: OUTCOME_WORDS[outcome] };
}
