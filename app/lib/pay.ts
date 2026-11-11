// Client pay page and downloads (batch-6 §3, §5, fixes 9-14, 17, 22; review F6, F7). Public: resolves only by token
// hashes and never returns version/invoice UUIDs or storage keys.
import type { Db, Queryable } from '../db/client';
import { licensedFile, licensedKey } from './access';
import { now as clockNow } from './clock';
import { scopeParts } from './format';
import { paymentReasonWords } from './grant';
import { lockCreator } from './policy';
import { price, scopeOptionIds, type RateCard, type Scope } from './pricing';
import { latestReceiptId } from './receipts';
import { contentTypeOf, extFor, readAsset } from './storage';
import { AppSecretError, encryptToken, hashToken, newToken, payPath, TOKEN_RE } from './tokens';
export { payLinkFromEnc } from './tokens';

/**
 * B8 review fix 5: the time a licence term is judged by on the pay page and for downloads. `real` itself in live mode;
 * real + the demo offset in demo mode, so a term over on the demo clock unlocks nothing even before the tick runs.
 */
const licenceNow = (q: Queryable, real: Date) => clockNow(q, process.env, () => real.getTime());

export const DOWNLOAD_TTL_MS = 5 * 60 * 1000;
export const DOWNLOAD_MAX_USES = 3;

/**
 * F6, F20: separate per-address hourly budgets, so a page left polling (40 reads per 2-minute session) or several
 * clients behind one address never spend the paid download allowance. PayPal itself is still asked at most once per
 * invoice per 10 s (PAY_PAGE_CHECK_MS), whatever the check budget.
 */
export const PAY_LIMITS = {
  pay_read: 1200, // GET /api/pay/:token, the 3 s database-only poll
  pay_check: 240, // POST .../check, page load / focus / "check now"
  pay_preview: 600, // the watermarked image
  download_issue: 60, // POST .../download
  download_serve: 120, // GET/HEAD /download/:token
  pay_renewal: 120, // POST .../renewal, the renewal opt-in checkbox (batch 8)
} as const;
export type PayLimitKind = keyof typeof PAY_LIMITS;

type PayRow = {
  invoice_id: string; version_id: string; creator_id: string; invoice_state: string; payer_url: string | null; invoice_number: string;
  v_status: string; rail: string | null; total_cents: number; scope: Scope; version_no: number; start_at: Date | null; end_at: Date | null;
  creator_name: string; title: string; key_preview: string; withdrawn_at: Date | null; renewal_opt_in: boolean;
};

export async function payRow(q: Queryable, token: string): Promise<PayRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [r] = await q.query<PayRow>(
    `select i.id as invoice_id, i.version_id, i.creator_id, i.state as invoice_state, i.payer_url, i.invoice_number,
            v.status as v_status, v.rail, v.total_cents, v.scope, v.version_no, v.start_at, v.end_at,
            cr.name as creator_name, a.title, a.key_preview, v.withdrawn_at, v.renewal_opt_in
       from invoices i join licence_versions v on v.id = i.version_id join creators cr on cr.id = v.creator_id
       join assets a on a.id = v.asset_id
      where i.pay_token_hash = $1`, [hashToken(token)]);
  return r ?? null;
}

export type PayStatus = 'unpaid' | 'paid' | 'refunded' | 'cancelled' | 'superseded' | 'expired';

export type PayView = {
  creatorName: string;
  assetTitle: string;
  scope: string;
  versionNo: number;
  totalCents: number;
  currency: 'USD';
  status: PayStatus;
  /** Batch 7 adds 'order' (card fields); the page keeps an empty slot for it (fix 17). */
  rail: 'invoice' | 'order';
  payerUrl: string | null;
  /** Fix 13: shown once PayPal confirmed it. */
  verified: { paypalTransactionId: string; amountCents: number; paidAt: string | null } | null;
  /** Fix 13: the latest refusal in plain words while unpaid. */
  refusal: string | null;
  fileLabel: string;
  receiptPath: string | null;
  term: { startAt: string | null; endAt: string | null };
  previewPath: string;
  /**
   * Batch 8 §2: the client's renewal choice. `canChange` is false once the licence ended or was refunded, or once its
   * renewal invoice is out (sending, sent or paid).
   */
  renewal?: { optIn: boolean; canChange: boolean };
  /** Display only, from this quote and its frozen parent, never today's rate card. */
  gap?: { currentScope: string | null; addedScope: string; combinedCents: number; paidCents: number; renewal: boolean };
};

/** Batch 8 §2: a licence's renewal choice is fixed once its renewal invoice is out (or the licence is over). */
async function renewalLocked(q: Queryable, r: Pick<PayRow, 'version_id' | 'v_status' | 'withdrawn_at' | 'invoice_state'>): Promise<boolean> {
  if (!(r.v_status === 'pending' || r.v_status === 'active') || r.withdrawn_at || r.invoice_state === 'cancelled') return true;
  const [sent] = await q.query(
    `select 1 from licence_versions c where c.renewal_of = $1
        and (c.send_state in ('sending', 'sent') or exists (select 1 from invoices i where i.version_id = c.id and i.state <> 'cancelled'))`,
    [r.version_id]);
  return !!sent;
}

export type RenewalChoiceResult = { ok: true } | { ok: false; status: 404 | 409; error: string };

/**
 * Batch 8 §2: saves the pay page's "Send me a renewal invoice before this licence ends" choice on the version, under
 * the creator lock (the tick reads it under the same lock). Allowed before and after payment, until the renewal is out.
 */
export async function setRenewalOptIn(db: Db, token: string, optIn: boolean): Promise<RenewalChoiceResult> {
  const head = await payRow(db, token);
  if (!head) return { ok: false, status: 404, error: 'This payment link is not valid.' };
  return db.transaction(async (tx) => {
    await lockCreator(tx, head.creator_id);
    const r = await payRow(tx, token);
    if (!r) return { ok: false as const, status: 404 as const, error: 'This payment link is not valid.' };
    if (await renewalLocked(tx, r)) return { ok: false as const, status: 409 as const, error: 'This choice can no longer change: the renewal invoice was already sent, or the licence is over.' };
    await tx.query(`update licence_versions set renewal_opt_in = $2 where id = $1`, [r.version_id, optIn]);
    return { ok: true as const };
  });
}

export async function payView(db: Db, token: string): Promise<PayView | null> {
  const r = await payRow(db, token);
  if (!r) return null;
  const termNow = (await licenceNow(db, new Date())).getTime(); // B8 review fix 5: the demo clock in demo mode only
  const status: PayStatus =
    r.v_status === 'refunded' || r.invoice_state === 'refunded' ? 'refunded'
    : r.v_status === 'active' ? (r.end_at && new Date(r.end_at).getTime() <= termNow ? 'expired' : 'paid')
    // F1: a quote withdrawn because its parent licence was refunded cannot be paid from this page.
    : r.invoice_state === 'cancelled' || (r.v_status === 'pending' && r.withdrawn_at) ? 'cancelled'
    : r.v_status === 'pending' ? 'unpaid'
    : r.v_status === 'expired' ? 'expired'
    : 'superseded';
  const [pay] = await db.query<{ paypal_txn_id: string; amount_cents: number; paid_at: Date | null }>(
    `select paypal_txn_id, amount_cents, paid_at from payments where version_id = $1 order by seq desc limit 1`, [r.version_id]);
  const [refused] = status === 'unpaid'
    ? await db.query<{ code: string }>(
      `select detail->>'code' as code from events where kind = 'grant' and detail->>'versionId' = $1 and (detail->>'pass')::boolean = false
        order by seq desc limit 1`, [r.version_id])
    : [];
  const receipt = status === 'unpaid' || status === 'cancelled' ? null : await latestReceiptId(db, r.version_id);
  const [quote] = await db.query<{ scope: Scope; rate_card: RateCard; renewal_of: string | null; parent_scope: Scope | null; parent_paid: number | null }>(
    `select v.scope, v.rate_card, v.renewal_of, p.scope as parent_scope, p.paid_cents as parent_paid
       from licence_versions v left join licence_versions p on p.id = v.parent_id where v.id = $1`, [r.version_id]);
  const held = new Set<string>(quote?.parent_scope ? scopeOptionIds(quote.parent_scope) : []);
  const gapDisplay = quote ? {
    currentScope: quote.parent_scope ? scopeParts(quote.parent_scope).map((p) => p.label).join(', ') : null,
    addedScope: scopeParts(quote.scope).filter((p) => quote.renewal_of || !held.has(p.id)).map((p) => p.label).join(', '),
    combinedCents: price(quote.scope, quote.rate_card).totalCents,
    paidCents: quote.renewal_of ? 0 : quote.parent_paid ?? 0,
    renewal: !!quote.renewal_of,
  } : undefined;
  return {
    creatorName: r.creator_name, assetTitle: r.title, scope: scopeParts(r.scope).map((p) => p.label).join(', '), versionNo: r.version_no,
    totalCents: r.total_cents, currency: 'USD', status, rail: r.rail === 'order' ? 'order' : 'invoice',
    gap: gapDisplay,
    payerUrl: status === 'unpaid' ? r.payer_url : null,
    verified: pay && (status === 'paid' || status === 'superseded' || status === 'expired')
      ? { paypalTransactionId: pay.paypal_txn_id, amountCents: pay.amount_cents, paidAt: pay.paid_at ? new Date(pay.paid_at).toISOString() : null }
      : null,
    refusal: refused?.code && !refused.code.startsWith('not_paid') ? paymentReasonWords(refused.code) : null,
    fileLabel: licensedFile(r.scope).label,
    receiptPath: receipt ? `/r/${receipt}` : null,
    term: { startAt: r.start_at ? new Date(r.start_at).toISOString() : null, endAt: r.end_at ? new Date(r.end_at).toISOString() : null },
    previewPath: `/api/pay/${token}/preview`,
    renewal: { optIn: r.renewal_opt_in, canChange: (status === 'unpaid' || status === 'paid') && !(await renewalLocked(db, r)) },
  };
}

const LOCKED = 'Payment not verified, file locked.';

/**
 * Fix 12: a download link for an active licence; 3 uses within 5 minutes; re-issuable while active.
 * F7: issued under the creator lock with the pay-token hash re-checked in the same transaction, so a link rotated
 * (or a licence revoked) while this request was running cannot gain a new download token.
 */
export async function issueDownload(db: Db, token: string, now: Date = new Date()): Promise<{ ok: true; url: string; expiresAt: Date } | { ok: false; status: 404 | 409; error: string }> {
  const r = await payRow(db, token);
  if (!r) return { ok: false, status: 404, error: 'link not found' };
  return db.transaction(async (tx) => {
    await lockCreator(tx, r.creator_id);
    const fresh = await payRow(tx, token); // revalidated under the lock that rotation and revocation take
    if (!fresh || fresh.invoice_id !== r.invoice_id) return { ok: false as const, status: 404 as const, error: 'link not found' };
    const termNow = await licenceNow(tx, now); // B8 review fix 5: the licence term reads the demo clock in demo mode only
    if (fresh.v_status !== 'active' || (fresh.end_at && new Date(fresh.end_at).getTime() <= termNow.getTime())) {
      return { ok: false as const, status: 409 as const, error: LOCKED };
    }
    const t = newToken();
    const expiresAt = new Date(now.getTime() + DOWNLOAD_TTL_MS);
    await tx.query(`insert into download_tokens (token_hash, creator_id, version_id, file, expires_at) values ($1, $2, $3, $4, $5)`,
      [hashToken(t), fresh.creator_id, fresh.version_id, licensedFile(fresh.scope).file, expiresAt]);
    return { ok: true as const, url: `/download/${t}`, expiresAt };
  });
}

export type DownloadResult =
  | { ok: true; bytes: Buffer | null; type: string; filename: string }
  | { ok: false; status: 404 | 410; error: string };

const GONE = 'This download link has expired or the licence is no longer active. Get a new one from the payment page.';

/**
 * Fix 22 + F7: the private file is read first; then, under the creator lock (which revocation and rotation hold
 * while they void tokens), one atomic UPDATE takes a use (uses < 3, not expired, not voided, version still active).
 * Only after that commits are the bytes returned. HEAD checks the same conditions under the lock without taking a
 * use. Bytes already dispatched cannot be recalled; the authorization boundary is immediately before dispatch.
 * `beforeAuthorize` is a test hook that runs between file preparation and authorization.
 */
export async function consumeDownload(db: Db, uploadsDir: string, token: string, opts: { head?: boolean; now?: Date; beforeAuthorize?: () => Promise<void> } = {}): Promise<DownloadResult> {
  if (!TOKEN_RE.test(token)) return { ok: false, status: 404, error: 'link not found' };
  const now = opts.now ?? new Date();
  const hash = hashToken(token);
  // B8 review fix 5: the token's own 5-minute life is real time ($2); the licence term ($3) reads the demo clock in
  // demo mode only (live: $3 = $2).
  const cond = `t.token_hash = $1 and t.uses < ${DOWNLOAD_MAX_USES} and t.expires_at > $2 and t.voided_at is null
                and v.id = t.version_id and v.status = 'active' and (v.end_at is null or v.end_at > $3)`;
  const [pre] = await db.query<{ file: 'web' | 'print'; creator_id: string; key_web: string; key_print: string; title: string }>(
    `select t.file, t.creator_id, a.key_web, a.key_print, a.title from download_tokens t, licence_versions v join assets a on a.id = v.asset_id where ${cond}`,
    [hash, now, await licenceNow(db, now)]);
  if (!pre) return { ok: false, status: 410, error: GONE };
  const bytes = await readAsset(uploadsDir, licensedKey(pre.file, pre));
  if (!bytes) return { ok: false, status: 404, error: 'The file is not available right now. Contact the photographer.' };
  await opts.beforeAuthorize?.();
  const authorized = await db.transaction(async (tx) => {
    await lockCreator(tx, pre.creator_id);
    // Fix round 2 R2: the clock is read after the file was prepared and the lock acquired, so a token or licence that
    // expired meanwhile is refused (GET and HEAD alike).
    const at = opts.now ?? new Date();
    const term = await licenceNow(tx, at);
    const rows = opts.head
      ? await tx.query(`select t.file from download_tokens t, licence_versions v where ${cond}`, [hash, at, term])
      : await tx.query(`update download_tokens t set uses = t.uses + 1 from licence_versions v where ${cond} returning t.file`, [hash, at, term]);
    return rows.length > 0;
  });
  if (!authorized) return { ok: false, status: 410, error: GONE };
  const type = contentTypeOf(bytes);
  const slug = pre.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'photo';
  return { ok: true, bytes: opts.head ? null : bytes, type, filename: `${slug}-${pre.file}.${extFor(type)}` };
}

/** The watermarked preview: the only public image (§5). */
export async function previewFor(db: Db, uploadsDir: string, token: string): Promise<{ bytes: Buffer; type: string } | null> {
  const r = await payRow(db, token);
  if (!r) return null;
  const bytes = await readAsset(uploadsDir, r.key_preview).catch(() => null);
  return bytes ? { bytes, type: contentTypeOf(bytes) } : null;
}

// ---------- creator side (fix 9) ----------

/**
 * "Replace link": a new token on the deal's live invoice; the old link stops working at once. F7: in the same
 * transaction every download token issued for the version is voided, so links issued from the old credential die too.
 */
export async function rotatePayLink(db: Db, creatorId: string, briefId: string): Promise<{ ok: true; path: string } | { ok: false; status: 404 | 409; error: string }> {
  try {
    return await db.transaction(async (tx) => {
      await lockCreator(tx, creatorId);
      const [inv] = await tx.query<{ id: string; version_id: string }>(
        `select i.id, i.version_id from invoices i join licence_versions v on v.id = i.version_id
          where v.brief_id = $1 and v.creator_id = $2 and i.state in ('sent', 'paid') order by i.seq desc limit 1`, [briefId, creatorId]);
      if (!inv) return { ok: false as const, status: 409 as const, error: 'there is no invoice out for this deal' };
      const t = newToken();
      await tx.query(`update invoices set pay_token_hash = $1, pay_token_enc = $2 where id = $3`, [hashToken(t), encryptToken(t), inv.id]);
      const voided = await tx.query(`update download_tokens set voided_at = now() where version_id = $1 and voided_at is null returning token_hash`, [inv.version_id]);
      await tx.query(`insert into events (creator_id, kind, detail) values ($1, 'pay_link.rotated', $2)`, [creatorId, JSON.stringify({ briefId, downloadsVoided: voided.length })]);
      return { ok: true as const, path: payPath(t) };
    });
  } catch (err) {
    if (err instanceof AppSecretError) return { ok: false, status: 409, error: 'APP_SECRET is not set on this server, so a new link cannot be made. The current link still works.' };
    throw err;
  }
}
