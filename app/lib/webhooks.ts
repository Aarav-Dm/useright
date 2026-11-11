// POST /api/paypal/webhook (batch-6 §2, §4, fixes 5, 8, 23; review F2, F4). Verified with PayPal, stored once per
// event id, then mapped to a version and handed to grantIfPaid / revocation, which re-fetch everything. The body
// itself decides nothing.
//
// Status codes (review ruling, docs/reviews/b6-final-fixes.md): 400 = missing signature headers, not a PayPal event, or
// PayPal verified the signature as bad (nothing stored). 503 = verification or a PayPal re-fetch failed or was
// unavailable, or handling hit a retryable failure (the stored row keeps processed_at null and a safe error, so
// PayPal's retry runs it again). 200 = processed, an already-processed duplicate, or an event that is not ours.
import type { Db } from '../db/client';
import { captureIdsOf, grantIfPaid, lockQuoteCapture, revokeFromCapture, type GrantDeps } from './grant';
import { lockCreator } from './policy';
import { logPayPalError, PayPalError, PayPalTimeout } from './paypal/client';
import { webhookId, WebhookConfigError, type WebhookHeaders } from './paypal/payments';
import { markInvoiceCancelled } from './send';

export type WebhookResult = { status: 200 | 400 | 503; body: Record<string, unknown> };

const HEADER_NAMES = {
  authAlgo: 'paypal-auth-algo', certUrl: 'paypal-cert-url', transmissionId: 'paypal-transmission-id',
  transmissionSig: 'paypal-transmission-sig', transmissionTime: 'paypal-transmission-time',
} as const;

export function transmissionHeaders(h: Headers): WebhookHeaders | null {
  const out: Partial<WebhookHeaders> = {};
  for (const [k, name] of Object.entries(HEADER_NAMES) as [keyof WebhookHeaders, string][]) {
    const v = h.get(name);
    if (!v || v.length > 2048) return null;
    out[k] = v;
  }
  return out as WebhookHeaders;
}

type Event = { id?: unknown; event_type?: unknown; resource?: Record<string, unknown> };

/** Invoice events carry the invoice under resource.invoice (seen live) or as the resource itself. */
function invoiceRef(resource: Record<string, unknown> | undefined) {
  const inv = (resource?.invoice ?? resource ?? {}) as { id?: unknown; detail?: { invoice_number?: unknown } };
  return { id: typeof inv.id === 'string' ? inv.id : null, number: typeof inv.detail?.invoice_number === 'string' ? inv.detail.invoice_number : null };
}

/** Fix 5: refund -> capture id from links[rel=up]; reversal -> resource.id. */
export function captureIdOf(type: string, resource: Record<string, unknown> | undefined): string | null {
  if (!resource) return null;
  if (type === 'PAYMENT.CAPTURE.REVERSED') return typeof resource.id === 'string' ? resource.id : null;
  const links = (resource.links ?? []) as { rel?: unknown; href?: unknown }[];
  const up = links.find((l) => l.rel === 'up' && typeof l.href === 'string');
  const m = up ? /\/v2\/payments\/captures\/([A-Z0-9]+)/.exec(up.href as string) : null;
  return m ? m[1]! : null;
}

async function versionForInvoice(db: Db, ref: { id: string | null; number: string | null }) {
  if (!ref.id && !ref.number) return null;
  const [r] = await db.query<{ id: string; version_id: string; creator_id: string; state: string; paypal_invoice_id: string | null }>(
    `select id, version_id, creator_id, state, paypal_invoice_id from invoices
      where ($1::text is not null and paypal_invoice_id = $1) or ($2::text is not null and invoice_number = $2)
      order by seq desc limit 1`, [ref.id, ref.number]);
  return r ?? null;
}

/** A failure PayPal's retry can fix (F2): the event stays unprocessed and the webhook answers 503. */
export class RetryableWebhookError extends Error {
  constructor(readonly code: string) {
    super(`retryable webhook failure: ${code}`);
    this.name = 'RetryableWebhookError';
  }
}

/** Grant refusals that a later delivery can turn into a grant (F2, F4, F8). Anything else is a final answer. */
const RETRY_GRANT = new Set(['paypal_unavailable', 'invoice_in_flight', 'file_unavailable']);

/** What one event does. Throws when PayPal cannot be asked or the work could not finish (PayPal retries). */
async function dispatch(deps: GrantDeps, eventId: string, type: string, resource: Record<string, unknown> | undefined): Promise<{ error: string | null; result: string }> {
  const { db } = deps;
  if (type === 'INVOICING.INVOICE.PAID' || type === 'INVOICING.INVOICE.UPDATED') {
    const inv = await versionForInvoice(db, invoiceRef(resource));
    if (!inv) return { error: 'unmapped', result: 'unmapped' };
    const g = await grantIfPaid(deps, inv.version_id, 'webhook');
    if (!g.granted && RETRY_GRANT.has(g.reason)) throw new RetryableWebhookError(g.reason);
    return { error: null, result: g.granted ? 'granted' : `not_granted:${g.reason}` };
  }
  if (type === 'INVOICING.INVOICE.CANCELLED') {
    const inv = await versionForInvoice(db, invoiceRef(resource));
    if (!inv) return { error: 'unmapped', result: 'unmapped' };
    if (!inv.paypal_invoice_id) throw new RetryableWebhookError('invoice_in_flight');
    const fresh = await deps.pp.payments.getInvoice(inv.paypal_invoice_id);
    if (fresh.status !== 'CANCELLED') return { error: null, result: `ignored:${String(fresh.status)}` };
    if (inv.state === 'cancelled' || inv.state === 'paid' || inv.state === 'refunded') return { error: null, result: 'already' };
    await db.transaction(async (tx) => {
      await lockCreator(tx, inv.creator_id);
      await markInvoiceCancelled(tx, inv.id, { supersede: true }); // batch-5 fix 18 / review 9: R3 released
      await tx.query(`insert into events (creator_id, kind, detail) values ($1, 'invoice.cancelled', $2)`,
        [inv.creator_id, JSON.stringify({ versionId: inv.version_id, paypalInvoiceId: inv.paypal_invoice_id, source: 'webhook' })]);
    });
    return { error: null, result: 'cancelled' };
  }
  if (type === 'INVOICING.INVOICE.REFUNDED') {
    const inv = await versionForInvoice(db, invoiceRef(resource));
    if (!inv) return { error: 'unmapped', result: 'unmapped' };
    const txns = await db.query<{ paypal_txn_id: string }>(`select paypal_txn_id from payments where version_id = $1`, [inv.version_id]);
    // F4 + fix round 2 (review #5): no payment recorded (not granted yet, or never grantable). Re-fetch the invoice and
    // treat each PayPal capture on it like a capture refund: kept as reversal evidence for a later grant, or closing a
    // locked quote. A final answer, so PayPal is not made to redeliver for days.
    if (txns.length === 0) {
      if (!inv.paypal_invoice_id) throw new RetryableWebhookError('invoice_in_flight');
      const fresh = await deps.pp.payments.getInvoice(inv.paypal_invoice_id);
      const caps = captureIdsOf(fresh);
      if (caps.length === 0) return { error: 'unmapped', result: 'unmapped' };
      // review final: a pending quote paid and refunded before any grant attempt records its capture, so it can close.
      if (caps.length === 1) await lockQuoteCapture(db, inv.version_id, caps[0]!);
      const out = [];
      for (const c of caps) {
        const r = await revokeFromCapture(deps, c, 'webhook', { eventId });
        if (r.cleanupIncomplete) throw new RetryableWebhookError('withdraw_incomplete');
        out.push(r.reason);
      }
      return { error: null, result: out.join(',') };
    }
    const out = [];
    for (const t of txns) {
      const r = await revokeFromCapture(deps, t.paypal_txn_id, 'webhook', { eventId });
      if (r.cleanupIncomplete) throw new RetryableWebhookError('withdraw_incomplete');
      out.push(r.reason);
    }
    return { error: null, result: out.join(',') };
  }
  if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
    const capture = captureIdOf(type, resource);
    if (!capture) return { error: 'unmapped', result: 'unmapped' };
    // F16: the refund's own id tells one partial refund from the next.
    const evidence = type === 'PAYMENT.CAPTURE.REFUNDED' && typeof resource?.id === 'string' ? resource.id : type;
    const r = await revokeFromCapture(deps, capture, 'webhook', { evidence, eventId });
    if (r.cleanupIncomplete) throw new RetryableWebhookError('withdraw_incomplete');
    return r.reason === 'unmapped' ? { error: 'unmapped', result: 'unmapped' } : { error: null, result: r.reason };
  }
  return { error: null, result: 'ignored' };
}

/** A short code safe to store on the event row (never a message, email or token). */
function errorCode(err: unknown): string {
  if (err instanceof RetryableWebhookError) return err.code;
  if (err instanceof PayPalError) return `paypal_${err.status}`;
  if (err instanceof PayPalTimeout) return 'paypal_unavailable';
  return 'internal';
}

/**
 * Missing transmission headers -> 400 with no PayPal call. Verification that throws for any reason (PayPal 4xx/5xx,
 * timeout, network rejection, missing PAYPAL_WEBHOOK_ID) -> 503: an outage is not a bad signature (F2). Only a
 * verdict other than SUCCESS -> 400, nothing stored. A processed duplicate -> 200 without repeating effects.
 */
export async function handleWebhook(deps: GrantDeps, headers: Headers, raw: string, env: NodeJS.ProcessEnv = process.env): Promise<WebhookResult> {
  const h = transmissionHeaders(headers);
  if (!h) return { status: 400, body: { error: 'missing PayPal transmission headers' } };
  let ev: Event;
  try {
    ev = JSON.parse(raw) as Event;
  } catch {
    return { status: 400, body: { error: 'body must be JSON' } };
  }
  const eventId = typeof ev.id === 'string' && /^[A-Z0-9-]{5,100}$/.test(ev.id) ? ev.id : null;
  const type = typeof ev.event_type === 'string' && /^[A-Z._]{3,100}$/.test(ev.event_type) ? ev.event_type : null;
  if (!eventId || !type) return { status: 400, body: { error: 'not a PayPal event' } };

  let verdict: string;
  try {
    verdict = await deps.pp.payments.verifyWebhook(h, raw, webhookId(env));
  } catch (err) {
    if (err instanceof WebhookConfigError) {
      console.warn('[webhook] PAYPAL_WEBHOOK_ID is not set');
      return { status: 503, body: { error: 'webhook not configured' } };
    }
    logPayPalError('verify webhook', err);
    return { status: 503, body: { error: 'PayPal verification unavailable' } };
  }
  // F10: only an explicit SUCCESS verifies; FAILURE, a missing status or anything else is a bad signature.
  if (verdict !== 'SUCCESS') return { status: 400, body: { error: 'signature not verified' } };

  const resource = ev.resource;
  const resourceId = typeof resource?.id === 'string' ? resource.id : invoiceRef(resource).id;
  await deps.db.query(`insert into webhook_events (event_id, type, resource_id) values ($1, $2, $3) on conflict (event_id) do nothing`,
    [eventId, type, resourceId?.slice(0, 100) ?? null]);
  const [row] = await deps.db.query<{ processed_at: Date | null }>(`select processed_at from webhook_events where event_id = $1`, [eventId]);
  if (row?.processed_at) return { status: 200, body: { ok: true, duplicate: true } };

  try {
    const { error, result } = await dispatch(deps, eventId, type, resource);
    // A final answer (including "not ours") is processed; only retryable failures stay open.
    await deps.db.query(`update webhook_events set processed_at = now(), error = $1 where event_id = $2`, [error, eventId]);
    return { status: 200, body: { ok: true, result } };
  } catch (err) {
    if (!(err instanceof RetryableWebhookError)) logPayPalError('webhook dispatch', err);
    await deps.db.query(`update webhook_events set error = $1 where event_id = $2 and processed_at is null`, [errorCode(err), eventId]);
    return { status: 503, body: { error: 'could not process the event yet; PayPal will retry' } };
  }
}
