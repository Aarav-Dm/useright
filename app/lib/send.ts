// Invoice send (batch-5 §3-§4, fixes 3, 4, 11-14, 17, 18). The invoices row (state 'creating') is written
// BEFORE any PayPal call; timeouts are resolved by searching the invoice_number, never by a blind retry.
import type { Db, Queryable } from '../db/client';
import { InvoiceLockedError, latestExtraction, loadBrief, type PolicyResult } from './briefs';
import { optionLabel, scopeParts } from './format';
import { centsToValue, parseCents } from './money';
import { PayPalConfigError } from './paypal/env';
import { logPayPalError, PayPalError, PayPalTimeout } from './paypal/client';
import type { InvoiceApi, PayPalInvoice } from './paypal/invoices';
import { evaluate, lockCreator } from './policy';
import { encryptToken, hasAppSecret, hashToken, newToken, payPath, publicBase } from './tokens';
import { hashOf, invoiceNumberFor, loadVersion, MAX_INVOICE_ATTEMPTS, newOptionIds, pendingVersionFor, saleRefusal, type VersionRow } from './versions';

export type SendMode = 'autopilot' | 'approval';
export type SendOk = { ok: true; invoiceNumber: string; paypalInvoiceId: string; payerUrl: string | null; already: boolean };
export type SendErr = { ok: false; status: 400 | 404 | 409 | 502; error: string; code?: string };
export type SendResult = SendOk | SendErr;

const usd = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function event(q: Queryable, creatorId: string, kind: string, detail: Record<string, unknown>) {
  await q.query(`insert into events (creator_id, kind, detail) values ($1, $2, $3)`, [creatorId, kind, JSON.stringify(detail)]);
}

/** PayPal holds a draft whose terms differ from the quote (B5 review 1). */
export class DraftMismatch extends Error {
  constructor() {
    super('draft terms differ from the quote');
    this.name = 'DraftMismatch';
  }
}

/** PayPal problem in plain words, with no secrets, tokens or emails (fix 20). */
export function sendErrorWords(err: unknown): string {
  if (err instanceof DraftMismatch) return 'PayPal saved the invoice with different terms (amount, currency, tip or partial payment), so it was not sent.';
  if (err instanceof SentMismatch) return 'PayPal shows an invoice under this number with a different amount or currency. It was not recorded as sent; check it in PayPal, then cancel and re-quote.';
  if (err instanceof PayPalConfigError) return 'PayPal is not set up on this server yet.';
  if (err instanceof PayPalTimeout) return 'PayPal did not answer in time, and no invoice was found under this number.';
  if (err instanceof PayPalError) return `PayPal refused the invoice (${err.issue ?? `HTTP ${err.status}`}).`;
  return 'Sending the invoice failed for an unexpected reason.';
}

type InvoiceRow = { id: string; invoice_number: string; paypal_invoice_id: string | null; state: string; payer_url: string | null; recipient_email: string | null; stale: boolean };

type Claim =
  | { kind: 'already'; invoiceRowId: string; invoiceNumber: string; paypalInvoiceId: string; payerUrl: string | null; repair: boolean }
  | { kind: 'busy' }
  | { kind: 'refused'; status: 404 | 409; error: string; code?: string }
  | { kind: 'claimed'; invoiceRowId: string; invoiceNumber: string; version: VersionRow; recipientEmail: string; payToken: string }
  /** An earlier send left a non-cancelled row behind (B5 review 1, 4, 5): finish or clear it first. */
  | { kind: 'reconcile'; row: InvoiceRow; version: VersionRow; recipientEmail: string };

export const STALE_SEND_MS = 2 * 60 * 1000;

async function parentRefusal(q: Queryable, v: VersionRow) {
  if (v.renewal_of || !v.parent_id) return null;
  const [parent] = await q.query(
    `select 1 from licence_versions where id = $1 and creator_id = $2 and client_id = $3 and asset_id = $4 and status = 'active'`,
    [v.parent_id, v.creator_id, v.client_id, v.asset_id]);
  return parent ? null : { status: 409 as const, error: 'the licence this quote extends is no longer current; edit the deal for a new quote. Nothing was sent.', code: 'parent_superseded' };
}

/**
 * B8 review fixes 1 and 2, under the creator lock right before a renewal's first PayPal call.
 * Fix 2 (both modes): the parent must still be the photo's current licence for this client (active, or expired with
 * no other active licence). If not, the renewal is cancelled (superseded), its reservation released, and a ledger row
 * written; nothing goes to PayPal.
 * Fix 1 (autopilot only): the client's renewal_opt_in is re-read; unticked releases the reservation and refuses, so
 * the caller re-evaluates and RENEW holds the renewal in Ask me. The creator's typed approval needs no opt-in.
 */
async function renewalStillWanted(tx: Queryable, v: VersionRow, mode: SendMode): Promise<Extract<Claim, { kind: 'refused' }> | null> {
  const [p] = await tx.query<{ status: string; renewal_opt_in: boolean; other_active: boolean }>(
    `select p.status, p.renewal_opt_in,
            exists (select 1 from licence_versions o where o.client_id = p.client_id and o.asset_id = p.asset_id and o.status = 'active' and o.id <> p.id) as other_active
       from licence_versions p where p.id = $1`, [v.renewal_of]);
  const current = !!p && (p.status === 'active' || (p.status === 'expired' && !p.other_active));
  if (!current) {
    await tx.query(`update licence_versions set status = 'superseded', send_state = 'idle' where id = $1 and status = 'pending'`, [v.id]);
    await tx.query(`update autopilot_sends set status = 'released' where version_id = $1 and status = 'reserved'`, [v.id]);
    await event(tx, v.creator_id, 'renewal.cancelled', {
      briefId: v.brief_id, versionId: v.id, parentId: v.renewal_of, parentStatus: p?.status ?? null,
      message: 'Renewal cancelled before sending: the licence it renews is no longer the current one for this photo. Nothing was sent to PayPal.',
    });
    return { kind: 'refused', status: 409, error: 'the licence this renews is no longer the current one, so the renewal was cancelled; nothing was sent', code: 'renewal_stale' };
  }
  if (mode === 'autopilot' && !p.renewal_opt_in) {
    await tx.query(`update autopilot_sends set status = 'released' where version_id = $1 and status = 'reserved'`, [v.id]);
    return { kind: 'refused', status: 409, error: 'the client no longer asks for a renewal invoice; it needs your approval', code: 'renewal_opt_out' };
  }
  return null;
}

/** Step 1, under the creator lock: one live invoice per version (the unique index is the backstop). */
async function claim(db: Db, versionId: string, mode: SendMode): Promise<Claim> {
  const head = await loadVersion(db, versionId);
  if (!head) return { kind: 'refused', status: 404, error: 'quote not found' };
  // Batch-6 review F11: without APP_SECRET the client link cannot be minted, so no invoice is created or sent.
  if (!hasAppSecret()) return { kind: 'refused', status: 409, error: 'APP_SECRET is not set on this server, so the client payment link cannot be made. Nothing was sent.', code: 'app_secret_missing' };
  return db.transaction(async (tx): Promise<Claim> => {
    await lockCreator(tx, head.creator_id);
    const v = await loadVersion(tx, versionId, true);
    if (!v || v.status !== 'pending') return { kind: 'refused', status: 409, error: 'this quote is no longer open' };
    // review 8: the recipient is read once, under the lock, and saved on the invoice row.
    const [client] = await tx.query<{ email: string }>(`select email from clients where id = $1`, [v.client_id]);
    const recipientEmail = client?.email ?? '';
    const [live] = await tx.query<InvoiceRow>(
      `select id, invoice_number, paypal_invoice_id, state, payer_url, recipient_email, (coalesce(attempt_at, created_at) < $2) as stale
         from invoices where version_id = $1 and state <> 'cancelled'`,
      [v.id, new Date(Date.now() - STALE_SEND_MS)]);
    if (live?.state === 'sent') {
      // B5 review 7: a sent invoice whose payer link was never read gets one more GET (never a new invoice).
      return { kind: 'already', invoiceRowId: live.id, invoiceNumber: live.invoice_number, paypalInvoiceId: live.paypal_invoice_id!, payerUrl: live.payer_url, repair: !live.payer_url };
    }
    if (live) {
      // An in-flight send owns the row; a failed or abandoned one (review 4: crash mid-send) is reconciled.
      if (v.send_state === 'sending' && !live.stale) return { kind: 'busy' };
      // review re-check 2: the recovery is claimed under the lock (send_state sending + a fresh attempt time), so a
      // cancel or a second Retry is refused until it finishes or goes stale.
      await tx.query(`update invoices set attempt_at = now() where id = $1`, [live.id]);
      await tx.query(`update licence_versions set send_state = 'sending', send_error = null where id = $1`, [v.id]);
      return { kind: 'reconcile', row: live, version: v, recipientEmail: live.recipient_email ?? recipientEmail };
    }

    if (v.renewal_of) {
      const refused = await renewalStillWanted(tx, v, mode);
      if (refused) return refused;
    }
    // Re-check under the lock even when approval already did the early check.
    const staleParent = await parentRefusal(tx, v);
    if (staleParent) {
      await tx.query(`update autopilot_sends set status = 'released' where version_id = $1 and status = 'reserved'`, [v.id]);
      await tx.query(`update licence_versions set send_state = 'failed', send_error = $2 where id = $1`, [v.id, staleParent.error]);
      return { kind: 'refused', ...staleParent };
    }

    // review's B11 build review 1: the shared first-send boundary. Every route that could make a first invoice passes here.
    const unsellable = await saleRefusal(tx, v);
    if (unsellable) {
      await tx.query(`update autopilot_sends set status = 'released' where version_id = $1 and status = 'reserved'`, [v.id]);
      return { kind: 'refused', ...unsellable };
    }

    if (mode === 'approval') {
      // §3: re-check hash, amount and recipient against the current version right before sending.
      const [ok] = await tx.query(
        `select 1 from approvals where version_id = $1 and version_hash = $2 and amount_cents = $3 and lower(recipient) = lower($4)`,
        [v.id, hashOf(v), v.total_cents, recipientEmail]);
      if (!ok || hashOf(v) !== v.content_hash) {
        return { kind: 'refused', status: 409, error: 'the quote changed after you approved it; approve the new total', code: 'approval_stale' };
      }
    } else {
      const [r] = await tx.query(`select 1 from autopilot_sends where version_id = $1 and status = 'reserved' and expires_at > now()`, [v.id]);
      if (!r) return { kind: 'refused', status: 409, error: 'no send reservation for this quote; run the checks again', code: 'no_reservation' };
      // B5 review 4: a settings save may have lowered the per-deal cap since evaluate() reserved this send.
      // The daily and 30-day limits stay enforced by the reservation row itself.
      const [s] = await tx.query<{ per_deal_cap_cents: number }>(`select per_deal_cap_cents from creator_settings where creator_id = $1`, [v.creator_id]);
      if (v.total_cents > (s?.per_deal_cap_cents ?? 0)) {
        await tx.query(`update autopilot_sends set status = 'released' where version_id = $1 and status = 'reserved'`, [v.id]);
        return { kind: 'refused', status: 409, error: `${usd(v.total_cents)} is now over your per-deal cap; it needs your approval`, code: 'over_deal_cap' };
      }
    }

    const [{ n }] = (await tx.query<{ n: number }>(`select count(*)::int as n from invoices where version_id = $1`, [v.id])) as [{ n: number }];
    if (n > MAX_INVOICE_ATTEMPTS) return { kind: 'refused', status: 409, error: 'too many send attempts for this quote; cancel and re-quote', code: 'too_many_attempts' };
    const invoiceNumber = invoiceNumberFor(v.id, n);
    // Batch-6 fix 9: the client's /pay link is minted with the row, so it can go in the invoice note before send.
    const payToken = newToken();
    const [row] = await tx.query<{ id: string }>(
      `insert into invoices (creator_id, version_id, invoice_number, state, recipient_email, pay_token_hash, pay_token_enc)
       values ($1, $2, $3, 'creating', $4, $5, $6) returning id`,
      [v.creator_id, v.id, invoiceNumber, recipientEmail, hashToken(payToken), encryptToken(payToken)]);
    await tx.query(`update licence_versions set send_state = 'sending', send_error = null where id = $1`, [v.id]);
    await event(tx, v.creator_id, 'invoice.creating', { briefId: v.brief_id, versionId: v.id, invoiceNumber, mode });
    return { kind: 'claimed', invoiceRowId: row!.id, invoiceNumber, version: v, recipientEmail, payToken };
  });
}

/**
 * The one cancellation transition (B5 review 9): invoice row cancelled, version send_state idle (and
 * optionally superseded), autopilot reservation released so R3 capacity comes back (fix 18).
 * Batch 6's INVOICING.INVOICE.CANCELLED webhook calls this too.
 */
export async function markInvoiceCancelled(tx: Queryable, invoiceId: string, opts: { supersede: boolean; error?: string | null }): Promise<void> {
  // Batch-6 review F4: a row grantIfPaid already settled (paid/refunded) is never cancelled locally.
  const [inv] = await tx.query<{ version_id: string }>(
    `update invoices set state = 'cancelled', error = coalesce($2, error) where id = $1 and state not in ('paid', 'refunded') returning version_id`, [invoiceId, opts.error ?? null]);
  if (!inv) return;
  await tx.query(
    `update licence_versions set send_state = 'idle'${opts.supersede ? `, status = case when status = 'pending' then 'superseded' else status end` : ''} where id = $1`,
    [inv.version_id]);
  await tx.query(`update autopilot_sends set status = 'released' where version_id = $1 and status in ('reserved', 'sent')`, [inv.version_id]);
}

/** Known outcome: no invoice of ours exists at PayPal under this row. Row cancelled, deal shows the error + Retry. */
async function failSend(db: Db, v: VersionRow, invoiceRowId: string, invoiceNumber: string, err: unknown, paypalInvoiceId: string | null): Promise<SendErr> {
  logPayPalError('sendInvoice', err);
  const words = sendErrorWords(err);
  await db.transaction(async (tx) => {
    if (paypalInvoiceId) await tx.query(`update invoices set paypal_invoice_id = $1 where id = $2`, [paypalInvoiceId, invoiceRowId]);
    await markInvoiceCancelled(tx, invoiceRowId, { supersede: false, error: words });
    await tx.query(`update licence_versions set send_state = 'failed', send_error = $1 where id = $2`, [words, v.id]);
    await event(tx, v.creator_id, 'invoice.failed', {
      briefId: v.brief_id, versionId: v.id, invoiceNumber, error: words,
      ...(err instanceof PayPalError ? { status: err.status, issue: err.issue, debugId: err.debugId } : {}),
    });
  });
  return { ok: false, status: 502, error: words, code: 'send_failed' };
}

/**
 * Unknown outcome (review 1, 5): PayPal may hold a live invoice or a draft. The row stays (state kept, PayPal id saved
 * when known) and the reservation is NOT released; Retry reconciles this exact row before any new number is used.
 */
async function holdSend(db: Db, v: VersionRow, invoiceRowId: string, invoiceNumber: string, err: unknown, paypalInvoiceId: string | null): Promise<SendErr> {
  logPayPalError('sendInvoice (unresolved)', err);
  const words = `${sendErrorWords(err)} Retry checks PayPal for this invoice before sending anything new.`;
  await db.transaction(async (tx) => {
    // review re-check 2: never touch a row that was cancelled meanwhile.
    const [kept] = await tx.query(`update invoices set error = $1, paypal_invoice_id = coalesce($2, paypal_invoice_id), state = case when $2::text is null then state else 'created' end
      where id = $3 and state in ('creating', 'created') returning id`, [words, paypalInvoiceId, invoiceRowId]);
    if (!kept) return;
    await tx.query(`update licence_versions set send_state = 'failed', send_error = $1 where id = $2`, [words, v.id]);
    await event(tx, v.creator_id, 'invoice.failed', { briefId: v.brief_id, versionId: v.id, invoiceNumber, error: words, unresolved: true });
  });
  return { ok: false, status: 502, error: words, code: 'send_unresolved' };
}

async function markSent(db: Db, v: VersionRow, invoiceRowId: string, invoiceNumber: string, paypalId: string, api: InvoiceApi, mode: SendMode | 'reconcile'): Promise<SendResult> {
  const payerUrl = await api.get(paypalId).then((i) => i.payerUrl, (e) => { logPayPalError('get after send', e); return null; });
  const done = await db.transaction(async (tx) => {
    // review re-check 2: a row cancelled while PayPal was being asked stays cancelled.
    const [row] = await tx.query(`update invoices set state = 'sent', paypal_invoice_id = $1, payer_url = $2, sent_at = now(), error = null
      where id = $3 and state in ('creating', 'created') returning id`, [paypalId, payerUrl, invoiceRowId]);
    if (!row) return false;
    await tx.query(`update licence_versions set rail = 'invoice', send_state = 'sent', send_error = null where id = $1`, [v.id]);
    // review 11: a slow send still counts toward R3 even if the sweep already released its reservation.
    // Exactly one row becomes 'sent': the live reservation, else the newest released one.
    // review 9: the cap ledger records when the invoice actually went out, so a send crossing midnight counts today.
    await tx.query(
      `update autopilot_sends set status = 'sent', sent_at = now() where id = (
         select id from autopilot_sends where version_id = $1 and status in ('reserved', 'released')
          order by (status = 'reserved') desc, seq desc limit 1)
         and not exists (select 1 from autopilot_sends where version_id = $1 and status = 'sent')`, [v.id]);
    await event(tx, v.creator_id, 'invoice.sent', { briefId: v.brief_id, versionId: v.id, invoiceNumber, paypalInvoiceId: paypalId, mode, totalCents: v.total_cents });
    return true;
  });
  if (!done) {
    // F4: PayPal's PAID webhook (or a page re-check) may have settled this row while the send was finishing.
    const [now] = await db.query<{ state: string }>(`select state from invoices where id = $1`, [invoiceRowId]);
    if (now?.state === 'paid' || now?.state === 'refunded') {
      if (payerUrl) await db.query(`update invoices set payer_url = coalesce(payer_url, $1) where id = $2`, [payerUrl, invoiceRowId]);
      return { ok: true, invoiceNumber, paypalInvoiceId: paypalId, payerUrl, already: true };
    }
    return CANCELLED_MEANWHILE;
  }
  return { ok: true, invoiceNumber, paypalInvoiceId: paypalId, payerUrl, already: false };
}

async function describe(db: Db, v: VersionRow, recipientEmail: string, payToken: string) {
  const [row] = await db.query<{ title: string; name: string }>(
    `select a.title, cr.name from assets a, creators cr where a.id = $1 and cr.id = $2`, [v.asset_id, v.creator_id]);
  const added = (await newOptionIds(db, v)).map(optionLabel);
  const words = scopeParts(v.scope).map((p) => p.label).join(', ');
  return {
    recipientEmail,
    itemName: `Image licence: ${row!.title} (${words})`.slice(0, 200),
    itemDescription: (v.renewal_of ? `Licence v${v.version_no}, renewal of the same licence for a new term`
      : v.parent_id ? `Licence v${v.version_no}, adds ${added.join(', ')}` : `Licence v${v.version_no}`).slice(0, 1000),
    // Batch-6 fix 9: PayPal's own email carries our page, where the file unlocks once PayPal confirms payment.
    note: `Licence fee for "${row!.title}" from ${row!.name}. After paying, download your file and rights receipt here: ${publicBase()}${payPath(payToken)}`.slice(0, 4000),
  };
}

/** review 11: only reuse an existing PayPal invoice that is ours: same number, exact amount, USD. */
const isOurs = (found: PayPalInvoice, v: VersionRow, invoiceNumber: string) =>
  found.invoiceNumber === invoiceNumber && found.amountValue === centsToValue(v.total_cents) && found.currency === 'USD';

/** Any PayPal status other than DRAFT (or CANCELLED) means the invoice went out (review 1: UNPAID, PAID, PAYMENT_PENDING...). */
const wentOut = (status: string) => status !== 'DRAFT' && status !== 'CANCELLED' && status !== '';

/** B5 review 1: the draft PayPal holds must be exactly what we priced before it is sent. */
const draftOk = (d: PayPalInvoice, v: VersionRow, invoiceNumber: string) =>
  isOurs(d, v, invoiceNumber) && d.allowTip !== true && d.allowPartial !== true;

/**
 * Sends a created draft. First reads it back (review 1): number, USD, exact amount, no tip, no partial payment;
 * a mismatch is deleted and nothing is sent. On a send error, PayPal's own state decides whether it went out (review 1).
 */
async function sendDraft(db: Db, api: InvoiceApi, v: VersionRow, rowId: string, number: string, paypalId: string, mode: SendMode | 'reconcile', known: PayPalInvoice | null = null): Promise<SendResult> {
  let draft: PayPalInvoice;
  try {
    draft = known ?? await api.get(paypalId);
  } catch (err) {
    logPayPalError('read back draft', err);
    return holdSend(db, v, rowId, number, err, paypalId); // a draft exists but is unchecked: never send it blind
  }
  if (wentOut(draft.status)) return acceptOut(db, api, v, rowId, number, draft, mode);
  if (draft.status === 'CANCELLED') return failSend(db, v, rowId, number, new DraftMismatch(), paypalId);
  if (!draftOk(draft, v, number)) {
    try {
      await api.remove(paypalId);
    } catch (rmErr) {
      logPayPalError('delete mismatched draft', rmErr);
      return holdSend(db, v, rowId, number, new DraftMismatch(), paypalId);
    }
    return failSend(db, v, rowId, number, new DraftMismatch(), paypalId);
  }
  try {
    await api.send(paypalId);
  } catch (err) {
    let after: PayPalInvoice;
    try {
      after = await api.get(paypalId);
    } catch (getErr) {
      logPayPalError('get after send error', getErr);
      return holdSend(db, v, rowId, number, err, paypalId); // cannot tell: keep the row
    }
    const status = after.status;
    if (wentOut(status)) return acceptOut(db, api, v, rowId, number, after, mode);
    if (status === 'CANCELLED') return failSend(db, v, rowId, number, err, paypalId);
    try {
      await api.remove(paypalId); // Fix 3: a draft that never went out is deleted
    } catch (rmErr) {
      logPayPalError('delete draft', rmErr);
      return holdSend(db, v, rowId, number, err, paypalId); // review 1: cancel only after delete succeeded
    }
    return failSend(db, v, rowId, number, err, paypalId);
  }
  return markSent(db, v, rowId, number, paypalId, api, mode);
}

/** PayPal shows an invoice under our number that went out with other terms (review re-check 3). */
export class SentMismatch extends Error {
  constructor() {
    super('sent invoice terms differ from the quote');
    this.name = 'SentMismatch';
  }
}

const CANCELLED_MEANWHILE: SendErr = { ok: false, status: 409, error: 'This invoice was cancelled while PayPal was being checked; nothing was changed.', code: 'cancelled_meanwhile' };

/**
 * An invoice PayPal shows as already out is recorded as sent only when it is ours: same number, exact amount, USD
 * (review re-check 3). A mismatch is held for the creator to look at; it is never marked sent and never re-sent.
 */
function acceptOut(db: Db, api: InvoiceApi, v: VersionRow, rowId: string, number: string, inv: PayPalInvoice, mode: SendMode | 'reconcile'): Promise<SendResult> {
  if (!isOurs(inv, v, number)) return holdSend(db, v, rowId, number, new SentMismatch(), inv.id);
  return markSent(db, v, rowId, number, inv.id, api, mode);
}

/** Finishes or clears a row an earlier attempt left behind, by asking PayPal (review 1, 4, 5). */
async function reconcile(db: Db, api: InvoiceApi, c: Extract<Claim, { kind: 'reconcile' }>): Promise<SendResult> {
  const { row, version: v } = c;
  let found: PayPalInvoice | null = null;
  try {
    found = row.paypal_invoice_id ? await api.get(row.paypal_invoice_id) : await api.findByNumber(row.invoice_number);
  } catch (err) {
    if (!(err instanceof PayPalError && err.status === 404)) return holdSend(db, v, row.id, row.invoice_number, err, row.paypal_invoice_id);
  }
  if (!found || found.status === 'CANCELLED' || found.invoiceNumber !== row.invoice_number) {
    // Nothing of ours is live under this number: clear the row; the next Retry uses the next number.
    const cleared = await db.transaction(async (tx) => {
      await lockCreator(tx, v.creator_id);
      const [r] = await tx.query<{ state: string }>(`select state from invoices where id = $1 for update`, [row.id]);
      if (!r || (r.state !== 'creating' && r.state !== 'created')) return false; // review re-check 2: changed meanwhile
      await markInvoiceCancelled(tx, row.id, { supersede: false, error: 'No live PayPal invoice was found for this attempt.' });
      await tx.query(`update licence_versions set send_state = 'failed', send_error = $1 where id = $2`, ['The earlier attempt did not reach PayPal. Retry to send it now.', v.id]);
      return true;
    });
    if (!cleared) return CANCELLED_MEANWHILE;
    return { ok: false, status: 409, error: 'The earlier attempt did not reach PayPal. Retry to send it now.', code: 'reconciled_missing' };
  }
  const [still] = await db.query(`update invoices set paypal_invoice_id = $1, state = 'created' where id = $2 and state in ('creating', 'created') returning id`, [found.id, row.id]);
  if (!still) return CANCELLED_MEANWHILE; // review re-check 2
  if (wentOut(found.status)) return acceptOut(db, api, v, row.id, row.invoice_number, found, 'reconcile'); // review re-check 3
  // review N1: never sent, and cancelled only after PayPal confirms the delete. PayPal refuses to delete a sent invoice, so a
  // stale DRAFT read fails safely. Anything else keeps the row and reservation for a later attempt to reconcile.
  const unsellable = await saleRefusal(db, v);
  if (unsellable) {
    const deleted = found.status === 'DRAFT' && await api.remove(found.id).then(() => true, (err) => { logPayPalError('delete unsellable draft', err); return false; });
    await db.transaction(async (tx) => {
      await lockCreator(tx, v.creator_id);
      const [r] = await tx.query<{ state: string }>(`select state from invoices where id = $1 for update`, [row.id]);
      if (!r || (r.state !== 'creating' && r.state !== 'created')) return; // a concurrent grant's paid row stays paid
      if (deleted) await markInvoiceCancelled(tx, row.id, { supersede: false, error: unsellable.error });
      else await tx.query(`update licence_versions set send_state = 'failed', send_error = $1 where id = $2`, [unsellable.error, v.id]);
    });
    return { ok: false, ...unsellable };
  }
  if (v.renewal_of) {
    // review B8 re-review 3: an unsent renewal draft gets the same parent check as a first send. If the parent moved on,
    // the row is cancelled and the draft deleted, so the client cannot pay a renewal that would unlock nothing.
    const stale = await db.transaction(async (tx) => {
      await lockCreator(tx, v.creator_id);
      const refused = await renewalStillWanted(tx, v, 'approval');
      if (refused) await markInvoiceCancelled(tx, row.id, { supersede: false, error: 'Renewal cancelled before sending: its licence is no longer the current one.' });
      return refused;
    });
    if (stale) {
      await api.remove(found.id).catch((err) => logPayPalError('delete stale renewal draft', err)); // an unsent draft cannot be paid
      return { ok: false, status: stale.status, error: stale.error, code: stale.code };
    }
  }
  return sendDraft(db, api, v, row.id, row.invoice_number, found.id, 'reconcile', found);
}

/**
 * sendInvoice(versionId). Autopilot needs a live reservation; approval needs a matching approvals row.
 * A duplicate call returns the existing invoice (or 409 while one is in flight): one invoice per version.
 */
export async function sendInvoice(db: Db, api: InvoiceApi, versionId: string, opts: { mode?: SendMode } = {}): Promise<SendResult> {
  const mode = opts.mode ?? 'autopilot';
  const c = await claim(db, versionId, mode);
  if (c.kind === 'already') {
    const out: SendOk = { ok: true, invoiceNumber: c.invoiceNumber, paypalInvoiceId: c.paypalInvoiceId, payerUrl: c.payerUrl, already: true };
    return c.repair ? { ...out, payerUrl: await repairPayerUrl(db, api, c.invoiceRowId, c.paypalInvoiceId) } : out;
  }
  if (c.kind === 'busy') return { ok: false, status: 409, error: 'this invoice is already being sent', code: 'sending' };
  if (c.kind === 'refused') return { ok: false, status: c.status, error: c.error, code: c.code };
  if (c.kind === 'reconcile') return reconcile(db, api, c);

  const v = c.version;
  let paypalId: string;
  let known: PayPalInvoice | null = null;
  try {
    paypalId = await api.create({ invoiceNumber: c.invoiceNumber, amountCents: v.total_cents, ...(await describe(db, v, c.recipientEmail, c.payToken)) });
  } catch (err) {
    const dup = err instanceof PayPalError && err.issue === 'DUPLICATE_INVOICE_NUMBER';
    const timeout = err instanceof PayPalTimeout;
    if (!dup && !timeout) return failSend(db, v, c.invoiceRowId, c.invoiceNumber, err, null); // fix 3: create refused
    // §4: duplicate -> fetch and reuse; timeout -> search by number, never a blind retry.
    let found: PayPalInvoice | null = null;
    try {
      found = await api.findByNumber(c.invoiceNumber);
    } catch (searchErr) {
      logPayPalError('search after create error', searchErr);
      return holdSend(db, v, c.invoiceRowId, c.invoiceNumber, err, null); // review 5: ambiguous, keep the row
    }
    if (!found) {
      // review 5: a timeout with no search hit is ambiguous (search can lag); a duplicate with no hit is not ours.
      return timeout ? holdSend(db, v, c.invoiceRowId, c.invoiceNumber, err, null) : failSend(db, v, c.invoiceRowId, c.invoiceNumber, err, null);
    }
    if (found.invoiceNumber !== c.invoiceNumber) return failSend(db, v, c.invoiceRowId, c.invoiceNumber, err, null);
    paypalId = found.id;
    if (wentOut(found.status)) {
      // Already out under our number. review 11: only claim it when amount and currency match the quote.
      if (!isOurs(found, v, c.invoiceNumber)) return holdSend(db, v, c.invoiceRowId, c.invoiceNumber, new DraftMismatch(), found.id);
      return markSent(db, v, c.invoiceRowId, c.invoiceNumber, paypalId, api, mode);
    }
    known = found; // a draft: sendDraft checks its terms (review 1) and deletes a mismatch
  }
  await db.query(`update invoices set paypal_invoice_id = $1, state = 'created' where id = $2`, [paypalId, c.invoiceRowId]);
  return sendDraft(db, api, v, c.invoiceRowId, c.invoiceNumber, paypalId, mode, known);
}

/** review 7: one GET for a sent invoice whose payer link was never read; saved when found. Never creates or sends. */
async function repairPayerUrl(db: Db, api: InvoiceApi, invoiceRowId: string, paypalId: string): Promise<string | null> {
  const url = await api.get(paypalId).then((i) => i.payerUrl, (e) => { logPayPalError('get payer link', e); return null; });
  if (url) await db.query(`update invoices set payer_url = $1 where id = $2 and payer_url is null`, [url, invoiceRowId]);
  return url;
}

// ---------- autopilot (fix 11) ----------

export type AutopilotResult =
  | { action: 'skipped'; reason: string }
  | { action: 'needs_approval'; versionId: string; policy: PolicyResult }
  | { action: 'sent'; versionId: string; send: SendOk }
  | { action: 'failed'; versionId: string; error: string };

/**
 * Runs after an extraction is saved (intake, transcript confirm, verify, creator edit). A `ready` extraction with
 * client + photo gets a pending version and evaluate(); all pass -> sendInvoice() with no creator click.
 */
export async function runAutopilot(db: Db, api: InvoiceApi, briefId: string): Promise<AutopilotResult> {
  const brief = await loadBrief(db, briefId);
  if (!brief || brief.state !== 'extracted' || !brief.client_id || !brief.asset_id) return { action: 'skipped', reason: 'not ready' };
  const x = await latestExtraction(db, briefId);
  if (!x || x.status !== 'ready') return { action: 'skipped', reason: 'checks not clear' };
  const pv = await pendingVersionFor(db, briefId);
  if (!pv.ok) return { action: 'skipped', reason: pv.error };
  if (pv.version.send_state === 'sent' || pv.version.send_state === 'sending') return { action: 'skipped', reason: 'already sent' };
  const ev = await evaluate(db, pv.version.id, { mode: 'autopilot' });
  if (!ev.ok) return { action: 'skipped', reason: ev.error };
  if (!ev.policy.pass) return { action: 'needs_approval', versionId: pv.version.id, policy: ev.policy };
  const s = await sendInvoice(db, api, pv.version.id, { mode: 'autopilot' });
  if (!s.ok && s.code === 'over_deal_cap') {
    // review 4: the cap dropped between evaluate() and claim(); evaluate again so R2 fails and the deal goes to Ask me.
    const again = await evaluate(db, pv.version.id, { mode: 'autopilot' });
    if (again.ok && !again.policy.pass) return { action: 'needs_approval', versionId: pv.version.id, policy: again.policy };
  }
  return s.ok ? { action: 'sent', versionId: pv.version.id, send: s } : { action: 'failed', versionId: pv.version.id, error: s.error };
}

// ---------- "Ask me" approval (§3, fixes 13, 17, 20) ----------

type OpenVersion = { ok: true; version: VersionRow } | { ok: false; status: 404 | 409; error: string; code?: string };

/**
 * The deal's open quote. Batch 8 plan fix 5 and review fix 3: a renewal deal has no AI reading; its quote is the one
 * renewal version the tick made, so approve, Retry and the payer-link re-read find it by brief, not by extraction.
 */
async function openVersionFor(db: Db, brief: { id: string; source: string }): Promise<OpenVersion> {
  if (brief.source !== 'renewal') return pendingVersionFor(db, brief.id);
  const [rv] = await db.query<{ id: string }>(`select id from licence_versions where brief_id = $1 and status = 'pending' order by seq desc limit 1`, [brief.id]);
  const version = rv ? await loadVersion(db, rv.id) : null;
  return version ? { ok: true, version } : { ok: false, status: 409, error: 'this renewal is no longer open' };
}

/** The sale refusal, early, for a quote with no invoice row. A live row goes on to claim(): only PayPal knows if it went out. */
async function refusalBeforeClaim(q: Queryable, v: VersionRow) {
  const [live] = await q.query(`select 1 from invoices where version_id = $1 and state <> 'cancelled'`, [v.id]);
  return live ? null : (await parentRefusal(q, v)) ?? saleRefusal(q, v);
}

export type ApproveResult = { ok: true; send: SendOk } | { ok: false; status: 400 | 404 | 409 | 502; error: string; code?: string; policy?: PolicyResult };

/** Creator types the exact total. typedTotal is the dollar text she typed ("900" or "900.00"). */
export async function approve(db: Db, api: InvoiceApi, creatorId: string, target: { briefId?: string; versionId?: string }, typedTotal: string): Promise<ApproveResult> {
  const typed = parseCents(typedTotal);
  if (typed === null) return { ok: false, status: 400, error: 'Type the total as a dollar amount, for example 420.00.', code: 'bad_amount' };

  let versionId = target.versionId ?? null;
  if (!versionId) {
    const brief = target.briefId ? await loadBrief(db, target.briefId) : null;
    if (!brief || brief.creator_id !== creatorId) return { ok: false, status: 404, error: 'deal not found' };
    const pv = await openVersionFor(db, brief);
    if (!pv.ok) return { ok: false, status: pv.status, error: pv.error, code: pv.code };
    versionId = pv.version.id;
  }
  const head = await loadVersion(db, versionId);
  if (!head || head.creator_id !== creatorId) return { ok: false, status: 404, error: 'quote not found' };
  const unsellable = await refusalBeforeClaim(db, head);
  if (unsellable) return { ok: false, ...unsellable }; // before an approval is recorded for what cannot be sent

  // Hard blocks (amount_too_small, missing_client_email) stop approval too; the result is logged for the ledger.
  const ev = await evaluate(db, versionId, { mode: 'approval' });
  if (!ev.ok) return { ok: false, status: ev.status, error: ev.error };
  if (ev.policy.hardBlock) {
    const first = ev.policy.results.find((r) => !r.pass && (r.rule === 'MIN' || r.rule === 'EMAIL'))!;
    return { ok: false, status: 409, error: first.message, code: first.code, policy: ev.policy };
  }

  const recorded = await db.transaction(async (tx) => {
    await lockCreator(tx, creatorId);
    const v = await loadVersion(tx, versionId, true);
    if (!v || v.status !== 'pending') return { ok: false as const, status: 409 as const, error: 'this quote is no longer open' };
    if (typed !== v.total_cents) return { ok: false as const, status: 400 as const, error: `Type ${centsToValue(v.total_cents)} to approve.`, code: 'amount_mismatch' };
    const [client] = await tx.query<{ email: string }>(`select email from clients where id = $1`, [v.client_id]);
    await tx.query(`insert into approvals (creator_id, version_id, version_hash, amount_cents, recipient) values ($1, $2, $3, $4, $5)`,
      [creatorId, v.id, v.content_hash, typed, client!.email]);
    await event(tx, creatorId, 'approved', { briefId: v.brief_id, versionId: v.id, amountCents: typed });
    return { ok: true as const };
  });
  if (!recorded.ok) return recorded;
  const send = await sendInvoice(db, api, versionId, { mode: 'approval' });
  return send.ok ? { ok: true, send } : send;
}

// ---------- reject, retry, cancel and re-quote ----------

/**
 * Rejects the deal's pending quote. B5 review 10: with `versionId` (the Ask me card), only that exact
 * version is rejected, and only while it is still the brief's pending quote; a stale card gets 409 `stale`.
 */
export async function reject(db: Db, creatorId: string, briefId: string, versionId?: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string; code?: string }> {
  const brief = await loadBrief(db, briefId);
  if (!brief || brief.creator_id !== creatorId) return { ok: false, status: 404, error: 'deal not found' };
  return db.transaction(async (tx) => {
    await lockCreator(tx, creatorId);
    const [live] = await tx.query(
      `select 1 from licence_versions v join invoices i on i.version_id = v.id where v.brief_id = $1 and v.status = 'pending' and i.state <> 'cancelled'`, [briefId]);
    if (live) return { ok: false as const, status: 409 as const, error: 'an invoice is out for this deal; cancel it first' };
    const pending = await tx.query<{ id: string }>(`select id from licence_versions where brief_id = $1 and status = 'pending' for update`, [briefId]);
    if (versionId !== undefined && !(pending.length === 1 && pending[0]!.id === versionId)) {
      return { ok: false as const, status: 409 as const, error: 'this quote changed since you opened it; refresh to see the current one', code: 'stale' };
    }
    for (const p of pending) {
      await tx.query(`update autopilot_sends set status = 'released' where version_id = $1 and status = 'reserved'`, [p.id]);
      await tx.query(`update licence_versions set status = 'draft', rejected_at = now() where id = $1`, [p.id]);
      // B5 review 6: one event per version with a singular versionId, so the ledger can join it.
      await event(tx, creatorId, 'rejected', { briefId, versionId: p.id });
    }
    if (pending.length === 0) {
      await tx.query(`update briefs set rejected_at = now() where id = $1`, [briefId]);
      await event(tx, creatorId, 'rejected', { briefId }); // resolved through the brief in the ledger
    }
    return { ok: true as const };
  });
}

/** Fix 12: Retry after a failed send re-runs evaluate() then send (approval path when she already approved). */
export async function retry(db: Db, api: InvoiceApi, creatorId: string, briefId: string): Promise<SendResult | { ok: false; status: 409; error: string; code: 'needs_approval' }> {
  const brief = await loadBrief(db, briefId);
  if (!brief || brief.creator_id !== creatorId) return { ok: false, status: 404, error: 'deal not found' };
  const pv = await openVersionFor(db, brief);
  if (!pv.ok) return { ok: false, status: pv.status, error: pv.error };
  // review 7: an invoice already out is never re-evaluated; sendInvoice returns it and re-reads a missing payer link.
  if (pv.version.send_state === 'sent') return sendInvoice(db, api, pv.version.id, { mode: 'autopilot' });
  const unsellable = await refusalBeforeClaim(db, pv.version);
  if (unsellable) return { ok: false, ...unsellable };
  const ev = await evaluate(db, pv.version.id, { mode: 'autopilot' });
  if (!ev.ok) return { ok: false, status: ev.status, error: ev.error };
  if (ev.policy.pass) return sendInvoice(db, api, pv.version.id, { mode: 'autopilot' });
  const [approved] = await db.query(`select 1 from approvals where version_id = $1`, [pv.version.id]);
  if (approved && !ev.policy.hardBlock) return sendInvoice(db, api, pv.version.id, { mode: 'approval' });
  return { ok: false, status: 409, error: 'this deal needs your approval in Ask me', code: 'needs_approval' };
}

/**
 * Fix 14 "Cancel invoice and re-quote": cancels the PayPal invoice, the version becomes superseded and its
 * autopilot reservation released (fix 18). The creator's next edit makes a new extraction and a new quote.
 */
export async function cancelAndRequote(db: Db, api: InvoiceApi, creatorId: string, briefId: string): Promise<{ ok: true } | SendErr> {
  const brief = await loadBrief(db, briefId);
  if (!brief || brief.creator_id !== creatorId) return { ok: false, status: 404, error: 'deal not found' };
  return cancelOpenInvoice(db, api, creatorId, { briefId });
}

/**
 * Cancels the open invoice of a deal's pending quote (`briefId`) or of one pending version (`versionId`; batch-6 fix
 * round 2, review #4: a withdrawn quote with no brief is cancelled by its own invoice). Codes: `no_invoice`;
 * `already_paid` only when PayPal shows money received (PAID / PARTIALLY_PAID); `payment_pending` (PAYMENT_PENDING,
 * try later); `marked_paid` (MARKED_AS_PAID by hand: no PayPal money, the mark must be removed in PayPal first).
 */
export async function cancelOpenInvoice(db: Db, api: InvoiceApi, creatorId: string, target: { briefId: string } | { versionId: string }): Promise<{ ok: true } | SendErr> {
  // B5 review 2: under the creator lock, so it cannot race claim() or a supersede. The PayPal call happens
  // inside the lock; cancelling is rare and must not interleave with a send of the same deal.
  const byBrief = 'briefId' in target;
  return db.transaction(async (tx): Promise<{ ok: true } | SendErr> => {
    await lockCreator(tx, creatorId);
    const [inv] = await tx.query<{ id: string; version_id: string; brief_id: string | null; paypal_invoice_id: string | null; invoice_number: string; state: string; send_state: string }>(
      `select i.id, i.version_id, v.brief_id, i.paypal_invoice_id, i.invoice_number, i.state, v.send_state
         from invoices i join licence_versions v on v.id = i.version_id
        where ${byBrief ? 'v.brief_id' : 'v.id'} = $1 and v.creator_id = $2 and v.status = 'pending' and i.state <> 'cancelled' for update of v`,
      [byBrief ? target.briefId : target.versionId, creatorId]);
    if (!inv) return { ok: false, status: 409, error: 'there is no invoice out for this deal', code: 'no_invoice' };
    const briefId = inv.brief_id;
    if (inv.send_state === 'sending') return { ok: false, status: 409, error: 'the invoice is still being sent; try again in a moment', code: 'sending' };
    try {
      let id = inv.paypal_invoice_id;
      let status: string | null = null;
      if (!id) {
        const found = await api.findByNumber(inv.invoice_number); // a held attempt (review 5) may exist at PayPal
        id = found?.id ?? null;
        status = found?.status ?? null;
      } else {
        // Batch-6 fix 4: always re-fetch; a paid invoice is never cancelled from here.
        status = (await api.get(id)).status;
      }
      // Fix round 2 (review major 1): only money actually received counts as paid (PARTIALLY_REFUNDED still holds some).
      if (status === 'PAID' || status === 'PARTIALLY_PAID' || status === 'PARTIALLY_REFUNDED') {
        return { ok: false, status: 409, error: 'PayPal shows a payment on this invoice; use Re-check PayPal instead of cancelling', code: 'already_paid' };
      }
      if (status === 'PAYMENT_PENDING') {
        return { ok: false, status: 409, error: 'PayPal shows a payment still pending on this invoice. Re-check PayPal in a few minutes before cancelling.', code: 'payment_pending' };
      }
      if (status === 'MARKED_AS_PAID') {
        return { ok: false, status: 409, error: 'This invoice is marked as paid by hand in PayPal, but no PayPal payment was received. Remove that mark in PayPal, then cancel again.', code: 'marked_paid' };
      }
      if (status === 'REFUNDED') {
        // review final (5bae423 check new #1): the money was paid and fully returned, and nothing was ever unlocked.
        // PayPal has nothing left to cancel, so the quote is closed here (no cancel call, which PayPal may refuse).
        await tx.query(`update invoices set state = 'refunded' where id = $1`, [inv.id]);
        await tx.query(`update licence_versions set status = 'superseded', send_state = 'idle' where id = $1 and status = 'pending'`, [inv.version_id]);
        await tx.query(`update autopilot_sends set status = 'released' where version_id = $1 and status in ('reserved', 'sent')`, [inv.version_id]);
        await event(tx, creatorId, 'invoice.cancelled', { briefId, versionId: inv.version_id, paypalInvoiceId: id, invoiceNumber: inv.invoice_number, paypalStatus: 'REFUNDED' });
        return { ok: true };
      }
      if (id && status === 'DRAFT') await api.remove(id);
      else if (id && status && status !== 'CANCELLED') await api.cancel(id);
    } catch (err) {
      logPayPalError('cancel invoice', err);
      return { ok: false, status: 502, error: sendErrorWords(err).replace('refused the invoice', 'refused to cancel the invoice'), code: 'cancel_failed' };
    }
    await markInvoiceCancelled(tx, inv.id, { supersede: true }); // review 9 + fix 18
    await event(tx, creatorId, 'invoice.cancelled', { briefId, versionId: inv.version_id, paypalInvoiceId: inv.paypal_invoice_id, invoiceNumber: inv.invoice_number });
    return { ok: true };
  });
}

export { InvoiceLockedError };
