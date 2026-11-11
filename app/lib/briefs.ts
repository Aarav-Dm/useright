// Extraction pipeline and the brief read model (batch-3 §4, §7 fixes 3, 5).
import type { Db, Queryable } from '../db/client';
import type { AiAdapter } from './ai/extract';
import { TranscriptSchema, type Transcript } from './ai/types';
import { OPTION_IDS } from './ai/prompts';
import { findQuote, quoteSupports, runChecks, type CheckResult } from './checks';
import { isDemoInvoiceId } from './demo';
import { gap, type Gap } from './gap';
import type { PricedOptionId, RateCard, Scope } from './pricing';
import { hasPaidUse } from './reasons';
import { payLinkFromEnc, publicBase } from './tokens';
import { paymentProof, type PaymentProof } from './proof';

export type BriefState = 'awaiting_verification' | 'awaiting_transcript' | 'extracted';
/** Batch 8: 'renewal' is a deal the tick opened for a renewal (no client message, no AI reading). */
export type IntakeSource = 'form' | 'paste' | 'screenshot' | 'portfolio' | 'renewal';

export type BriefRow = {
  id: string;
  creator_id: string;
  client_id: string | null;
  asset_id: string | null;
  source: IntakeSource;
  raw: string | null;
  claimed_sender: string | null;
  upload_path: string | null;
  state: BriefState;
  created_at: Date;
  /** Batch 5: set when the creator rejects the deal; cleared by a new extraction. */
  rejected_at?: Date | null;
  /** Page confirmation acknowledges a request without proving ownership of its claimed email. */
  confirmed_on_page?: boolean;
};

export type StoredChecks = Pick<CheckResult, 'kept' | 'dropped' | 'requested'> & { notes?: string[] };

export type ExtractionRow = {
  id: string;
  status: CheckResult['status'];
  reasons: string[];
  model: string | null;
  suggested_price_cents: number | null;
  clarifying_question: string | null;
  raw: StoredChecks;
  raw_model: unknown;
  created_at: Date;
};

export type TranscriptRow = { id: string; lines: Transcript['lines']; confirmed_at: Date | null; created_at: Date };

/** Picks the adapter for a brief; the fixture name is only honoured in fixture mode. */
export type AiFor = (fixture: string | null) => AiAdapter;

export async function loadBrief(q: Queryable, briefId: string): Promise<BriefRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(briefId)) return null;
  const rows = await q.query<BriefRow>(`select * from briefs where id = $1`, [briefId]);
  return rows[0] ?? null;
}

async function latestTranscript(q: Queryable, briefId: string): Promise<TranscriptRow | null> {
  const rows = await q.query<TranscriptRow>(
    `select id, lines, confirmed_at, created_at from transcripts where brief_id = $1 order by seq desc limit 1`,
    [briefId],
  );
  return rows[0] ?? null;
}

export async function latestExtraction(q: Queryable, briefId: string): Promise<ExtractionRow | null> {
  const rows = await q.query<ExtractionRow>(
    `select id, status, reasons, model, suggested_price_cents, clarifying_question, raw, raw_model, created_at
       from extractions where brief_id = $1 order by seq desc limit 1`,
    [briefId],
  );
  return rows[0] ?? null;
}

export async function briefFixture(q: Queryable, briefId: string): Promise<string | null> {
  const rows = await q.query<{ fixture: string | null }>(
    `select detail->>'fixture' as fixture from events where kind = 'intake.created' and detail->>'briefId' = $1 limit 1`,
    [briefId],
  );
  return rows[0]?.fixture ?? null;
}

export async function saveTranscript(
  q: Queryable,
  brief: BriefRow,
  transcript: Transcript,
  confirmed: boolean,
): Promise<string> {
  const rows = await q.query<{ id: string }>(
    `insert into transcripts (creator_id, client_id, source, raw, brief_id, lines, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      brief.creator_id, brief.client_id, brief.source,
      transcript.lines.map((l) => `${l.speaker}: ${l.text}`).join('\n'),
      brief.id, JSON.stringify(transcript.lines), confirmed ? new Date() : null,
    ],
  );
  return rows[0]!.id;
}

// ---------- gap preview (fix 5) ----------

export type Licence = { versionId: string; scope: Scope; rateCard: RateCard; paidCents: number };

export async function activeLicence(q: Queryable, clientId: string | null, assetId: string | null): Promise<Licence | null> {
  if (!clientId || !assetId) return null;
  const rows = await q.query<{ id: string; scope: Scope; rate_card: RateCard; paid_cents: number }>(
    `select id, scope, rate_card, paid_cents from licence_versions
      where client_id = $1 and asset_id = $2 and status = 'active'
      order by version_no desc limit 1`,
    [clientId, assetId],
  );
  const r = rows[0];
  return r ? { versionId: r.id, scope: r.scope, rateCard: r.rate_card, paidCents: r.paid_cents } : null;
}

/** Batch 6: the licence a paid version extended (its parent), as gapPreview's base; null for a v1. */
async function parentLicence(q: Queryable, versionId: string): Promise<Licence | null> {
  const [p] = await q.query<{ id: string; scope: Scope; rate_card: RateCard; paid_cents: number }>(
    `select p.id, p.scope, p.rate_card, p.paid_cents from licence_versions v join licence_versions p on p.id = v.parent_id where v.id = $1`, [versionId]);
  return p ? { versionId: p.id, scope: p.scope, rateCard: p.rate_card, paidCents: p.paid_cents } : null;
}

export async function creatorCard(q: Queryable, creatorId: string): Promise<RateCard> {
  const rows = await q.query<{ option_id: PricedOptionId; cents: number }>(
    `select option_id, cents from rate_card_options where creator_id = $1`,
    [creatorId],
  );
  return Object.fromEntries(rows.map((r) => [r.option_id, r.cents])) as RateCard;
}

export type GapPreview = Gap & { against: 'empty' | 'licence'; parentVersionId: string | null };

/**
 * The only price path: requested scope through gap(). The model's suggested price is never an input.
 * `frozenCard` (review 1): the rate card a quote froze when it was made; without it, the licence's card (vN) or the
 * creator's current card (v1).
 */
export async function gapPreview(q: Queryable, brief: BriefRow, requested: Scope | null, frozenCard: RateCard | null = null, licenceOverride?: Licence | null): Promise<GapPreview | null> {
  if (!requested) return null;
  const licence = licenceOverride !== undefined ? licenceOverride : await activeLicence(q, brief.client_id, brief.asset_id);
  if (licence) {
    return { ...gap(requested, licence.scope, licence.paidCents, frozenCard ?? licence.rateCard), against: 'licence', parentVersionId: licence.versionId };
  }
  return { ...gap(requested, null, 0, frozenCard ?? await creatorCard(q, brief.creator_id)), against: 'empty', parentVersionId: null };
}

// ---------- extraction ----------

export async function extractBrief(db: Db, aiFor: AiFor, briefId: string): Promise<ExtractionRow> {
  const brief = await loadBrief(db, briefId);
  if (!brief) throw new Error('brief not found');
  const transcriptRow = await latestTranscript(db, briefId);
  if (!transcriptRow) throw new Error('brief has no transcript');
  const transcript = TranscriptSchema.parse({ lines: transcriptRow.lines });

  const assetRows = brief.asset_id
    ? await db.query<{ title: string }>(`select title from assets where id = $1`, [brief.asset_id])
    : [];
  // Code-review fix 8: if the adapter cannot be built or throws, record ai_invalid (needs_creator) so the brief
  // is never left stuck between states. The creator can confirm the transcript again later.
  let result: Awaited<ReturnType<AiAdapter['extract']>>;
  try {
    const ai = aiFor(await briefFixture(db, briefId));
    result = await ai.extract(transcript, assetRows[0]?.title ?? null);
  } catch (err) {
    result = { ok: false, reason: 'ai_invalid', model: 'unavailable', raw: { error: err instanceof Error ? err.message : String(err) } };
  }
  const licence = await activeLicence(db, brief.client_id, brief.asset_id);

  let status: CheckResult['status'];
  let reasons: string[];
  let stored: StoredChecks;
  let suggested: number | null = null;
  let question: string | null = null;
  if (!result.ok) {
    status = 'needs_creator';
    reasons = ['ai_invalid'];
    stored = { kept: [], dropped: [], requested: null };
  } else {
    const checks = runChecks({ transcript, extraction: result.value, current: licence?.scope ?? null });
    status = checks.status;
    reasons = checks.reasons;
    stored = { kept: checks.kept, dropped: checks.dropped, requested: checks.requested };
    suggested = result.value.suggestedPriceCents ?? null;
    question = checks.clarifyingQuestion;
  }
  return persistExtraction(db, brief, transcriptRow.id, {
    status, reasons, stored, model: result.model, suggested, question, rawModel: result.raw ?? null,
  });
}

type ExtractionWrite = {
  /** Apply brief.client_id / asset_id inside the locked transaction (creator edit). */
  briefUpdate?: boolean;
  status: CheckResult['status'];
  reasons: string[];
  stored: StoredChecks;
  model: string;
  suggested: number | null;
  question: string | null;
  rawModel: unknown;
};

/** One write path for AI and creator extractions. Applies the A2 identity rule last. */
async function persistExtraction(db: Db, brief: BriefRow, transcriptId: string, w: ExtractionWrite): Promise<ExtractionRow> {
  let { status, reasons } = w;
  const { stored } = w;
  // A2: identity never comes from AI text. No client on the brief -> the creator decides.
  if (!brief.client_id) {
    status = 'needs_creator';
    reasons = ['unknown_sender', ...reasons.filter((r) => r !== 'unknown_sender')];
  }

  return db.transaction(async (tx) => {
    // B5 review 2: the same creator lock as claim()/approve, so a supersede can never interleave with a send.
    await tx.query(`select pg_advisory_xact_lock(hashtext($1::text))`, [brief.creator_id]);
    // Batch-5 fixes 14, 16: a new extraction makes older pending versions stale. Refuse while an invoice is
    // live for one (the creator must cancel it and re-quote); otherwise supersede them and free reservations.
    await supersedePending(tx, brief.id);
    if (w.briefUpdate) {
      await tx.query(`update briefs set client_id = $1, asset_id = $2 where id = $3`, [brief.client_id, brief.asset_id, brief.id]);
      await tx.query(`update transcripts set client_id = $1 where brief_id = $2`, [brief.client_id, brief.id]);
    }
    await tx.query(`update briefs set rejected_at = null where id = $1`, [brief.id]);
    const rows = await tx.query<ExtractionRow>(
      `insert into extractions
         (creator_id, client_id, source, raw, brief_id, transcript_id, status, reasons, model,
          suggested_price_cents, clarifying_question, raw_model)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning id, status, reasons, model, suggested_price_cents, clarifying_question, raw, raw_model, created_at`,
      [
        brief.creator_id, brief.client_id, brief.source, JSON.stringify(stored), brief.id, transcriptId,
        status, reasons, w.model, w.suggested, w.question, JSON.stringify(w.rawModel),
      ],
    );
    if (stored.dropped.length > 0) {
      await tx.query(
        `insert into events (creator_id, kind, detail) values ($1, 'extraction.dropped', $2)`,
        [brief.creator_id, JSON.stringify({ briefId: brief.id, dropped: stored.dropped })],
      );
    }
    await tx.query(`update briefs set state = 'extracted' where id = $1`, [brief.id]);
    return rows[0]!;
  });
}

/** Creator confirms (and may relabel) the transcript; extraction then runs (fix 3). */
export async function confirmTranscript(db: Db, aiFor: AiFor, briefId: string, transcript: Transcript): Promise<ExtractionRow> {
  const brief = await loadBrief(db, briefId);
  if (!brief) throw new Error('brief not found');
  if (brief.state === 'awaiting_verification') throw new Error('brief is waiting for email verification');
  await saveTranscript(db, brief, transcript, true);
  return extractBrief(db, aiFor, briefId);
}

// ---------- licence version state (batch 5) ----------

export class InvoiceLockedError extends Error {
  constructor() {
    super('an invoice is out for this deal; cancel it and re-quote first');
    this.name = 'InvoiceLockedError';
  }
}

/** True when a pending version of the brief has a non-cancelled invoice (scope and recipient are frozen). */
export async function invoiceLocked(q: Queryable, briefId: string): Promise<boolean> {
  const rows = await q.query(
    `select 1 from licence_versions v join invoices i on i.version_id = v.id
      where v.brief_id = $1 and v.status = 'pending' and i.state <> 'cancelled' limit 1`,
    [briefId],
  );
  return rows.length > 0;
}

/** Marks the brief's pending versions superseded and releases their reservations (fixes 14, 16). */
export async function supersedePending(q: Queryable, briefId: string): Promise<void> {
  if (await invoiceLocked(q, briefId)) throw new InvoiceLockedError();
  await q.query(
    `update autopilot_sends set status = 'released'
      where status = 'reserved' and version_id in (select id from licence_versions where brief_id = $1 and status = 'pending')`,
    [briefId],
  );
  await q.query(`update licence_versions set status = 'superseded' where brief_id = $1 and status = 'pending'`, [briefId]);
}

export type RuleResult = { rule: string; pass: boolean; code: string; message: string };
export type PolicyResult = { pass: boolean; hardBlock: boolean; results: RuleResult[]; evaluatedAt: string; mode: 'autopilot' | 'approval' };

export type DealVersion = {
  id: string;
  versionNo: number;
  status: string;
  totalCents: number;
  scope: Scope;
  contentHash: string | null;
  sendState: 'idle' | 'sending' | 'sent' | 'failed';
  sendError: string | null;
  policy: PolicyResult | null;
  extractionId: string | null;
  rejectedAt: Date | null;
  createdAt: Date;
  invoice: {
    invoiceNumber: string; paypalInvoiceId: string | null; state: string; payerUrl: string | null; sentAt: Date | null;
    /** Batch-6 fix 9: the client's /pay link (same token every time until rotated). Creator-only read model. */
    payPath: string | null; lastCheckedAt: Date | null;
    /** Batch-6 review F17: the same absolute link the PayPal invoice note carries (PUBLIC_BASE_URL origin). */
    payUrl: string | null;
    /** Batch 7: seeded demo invoice (`INV2-DEMO-`), never PayPal evidence. Display only. */
    demo: boolean;
  } | null;
};

export const DEAL_VERSION_SQL = `
  select v.id, v.version_no, v.status, v.total_cents, v.scope, v.content_hash, v.send_state, v.send_error, v.policy,
         v.extraction_id, v.rejected_at, v.created_at,
         i.invoice_number, i.paypal_invoice_id, i.state as invoice_state, i.payer_url, i.sent_at, i.pay_token_enc, i.last_checked_at
    from licence_versions v
    left join lateral (select * from invoices where version_id = v.id order by seq desc limit 1) i on true`;

export type DealVersionRow = {
  id: string; version_no: number; status: string; total_cents: number; scope: Scope; content_hash: string | null;
  send_state: DealVersion['sendState']; send_error: string | null; policy: PolicyResult | null; extraction_id: string | null;
  rejected_at: Date | null; created_at: Date; invoice_number: string | null; paypal_invoice_id: string | null;
  invoice_state: string | null; payer_url: string | null; sent_at: Date | null; pay_token_enc?: string | null; last_checked_at?: Date | null;
};

function payLinks(enc: string | null): { payPath: string | null; payUrl: string | null } {
  const payPath = payLinkFromEnc(enc);
  return { payPath, payUrl: payPath ? `${publicBase()}${payPath}` : null };
}

export function toDealVersion(r: DealVersionRow): DealVersion {
  return {
    id: r.id, versionNo: r.version_no, status: r.status, totalCents: r.total_cents, scope: r.scope, contentHash: r.content_hash,
    sendState: r.send_state, sendError: r.send_error, policy: r.policy, extractionId: r.extraction_id, rejectedAt: r.rejected_at,
    createdAt: r.created_at,
    invoice: r.invoice_number
      ? { invoiceNumber: r.invoice_number, paypalInvoiceId: r.paypal_invoice_id, state: r.invoice_state!, payerUrl: r.payer_url, sentAt: r.sent_at,
          ...payLinks(r.pay_token_enc ?? null), lastCheckedAt: r.last_checked_at ?? null, demo: isDemoInvoiceId(r.paypal_invoice_id) }
      : null,
  };
}

/** The brief's most recent licence version with its latest invoice, or null. */
export async function currentVersion(q: Queryable, briefId: string): Promise<DealVersion | null> {
  const [r] = await q.query<DealVersionRow>(`${DEAL_VERSION_SQL} where v.brief_id = $1 order by v.seq desc limit 1`, [briefId]);
  return r ? toDealVersion(r) : null;
}

// ---------- read model (§4, batch-4 §3) ----------

export type DealStatus =
  | CheckResult['status'] | 'awaiting_verification' | 'awaiting_transcript'
  // batch 5 (fix 8, 12): a version exists for the deal
  | 'needs_approval' | 'sending' | 'invoiced' | 'failed' | 'cancelled' | 'rejected'
  // batch 6: PayPal confirmed payment / refunded it
  | 'paid' | 'refunded'
  // batch 8: the term ended without a paid renewal
  | 'expired';

export type DealContext = {
  version: Pick<DealVersion, 'status' | 'sendState' | 'policy' | 'extractionId' | 'rejectedAt'> & { invoiceState: string | null } | null;
  briefRejectedAt: Date | null;
  latestExtractionId: string | null;
};

/**
 * The one status rule (batch-4 fix 1, batch-5 fix 8) plus the reasons a screen should show, for every state
 * including those with no price yet. Deals list and deal room both call this; screens never derive it.
 */
export function dealState(
  state: BriefState,
  extraction: { status: CheckResult['status']; reasons: string[] } | null,
  transcriptLineCount: number | null,
  deal: DealContext | null = null,
): { status: DealStatus; reasons: string[] } {
  if (state === 'awaiting_verification') return { status: 'awaiting_verification', reasons: ['awaiting_verification'] };
  if (state === 'awaiting_transcript') {
    return { status: 'awaiting_transcript', reasons: transcriptLineCount ? ['awaiting_transcript'] : ['transcript_empty'] };
  }
  const v = deal?.version;
  if (v) {
    // Batch 6: the quote for this request was paid (or refunded); only grantIfPaid / revocation set these.
    if (v.extractionId === deal!.latestExtractionId && (v.status === 'active' || v.status === 'superseded') && v.invoiceState === 'paid') return { status: 'paid', reasons: [] };
    if (v.extractionId === deal!.latestExtractionId && v.status === 'refunded') return { status: 'refunded', reasons: ['refunded'] };
    // Batch 8: the tick ended the licence (no paid renewal by its end date).
    if (v.extractionId === deal!.latestExtractionId && v.status === 'expired') return { status: 'expired', reasons: ['expired'] };
    if (v.status === 'pending') {
      if (v.invoiceState === 'sent') return { status: 'invoiced', reasons: [] };
      if (v.sendState === 'sending') return { status: 'sending', reasons: [] };
      if (v.sendState === 'failed') return { status: 'failed', reasons: ['send_failed'] };
      if (v.policy && !v.policy.pass) return { status: 'needs_approval', reasons: v.policy.results.filter((r) => !r.pass).map((r) => r.code) };
    }
    if (v.status === 'superseded' && v.invoiceState === 'cancelled' && v.extractionId === deal!.latestExtractionId) {
      return { status: 'cancelled', reasons: ['invoice_cancelled'] };
    }
    // review 11: an old rejection never hides the state of a newer extraction.
    if (v.status === 'draft' && v.rejectedAt && v.extractionId === deal!.latestExtractionId) return { status: 'rejected', reasons: ['rejected'] };
  }
  if (deal?.briefRejectedAt) return { status: 'rejected', reasons: ['rejected'] };
  if (!extraction) return { status: 'needs_creator', reasons: ['no_extraction'] };
  return { status: extraction.status, reasons: extraction.reasons };
}

export type LicenceCard = {
  versionId: string;
  versionNo: number;
  scope: Scope;
  status: string;
  startAt: Date | null;
  endAt: Date | null;
  totalCents: number;
  paidCents: number;
  /** Batch 8: the client asked for a renewal invoice (pay page checkbox). */
  renewalOptIn?: boolean;
  /** Batch 8: this licence's renewal invoice is out (sent or paid). */
  renewalSent?: boolean;
};

export type BriefView = {
  brief: Omit<BriefRow, 'upload_path'> & { hasImage: boolean };
  /** From dealState(): what the screens show as the deal's status and why. */
  status: DealStatus;
  reasons: string[];
  /** Findings the creator reviewed herself (creator edits); shown, never blocking. */
  notes: string[];
  client: { id: string; name: string; email: string; allowed: boolean } | null;
  asset: { id: string; title: string } | null;
  transcript: TranscriptRow | null;
  extraction: ExtractionRow | null;
  checks: { status: CheckResult['status']; reasons: string[] } & StoredChecks | null;
  /** The client's active licence on this asset, or null for a v1. */
  licence: LicenceCard | null;
  /** Where every gap line's price comes from, e.g. "rate card (frozen v1)" or "rate card (current)". */
  cardSource: string | null;
  gapPreview: GapPreview | null;
  /** Batch 5: the deal's latest licence version (pending quote, sent invoice, rejection...) or null. */
  version: DealVersion | null;
  /** review 5: false while an invoice is out (or before the request is read); edit controls are disabled. */
  editable: boolean;
  /** Batch-6 fix 18: when PayPal last reached our webhook (any event). */
  webhookLastReceivedAt: Date | null;
  /** B11 item 2: who sent this deal's real invoice: 'you' when an approval row exists, otherwise the agent. Null before a send and for seeded invoices. */
  sentBy?: 'agent' | 'you' | null;
  /** B11 item 5: the licence a renewal deal renews. Display only; the price still comes from the renewal's own scope. */
  renewalParent?: { versionNo: number; scope: Scope } | null;
  /** B12 D1: PayPal evidence for the deal's invoice (null before a real send, and for seeded invoices). */
  proof?: PaymentProof | null;
};

async function licenceCard(q: Queryable, clientId: string | null, assetId: string | null): Promise<LicenceCard | null> {
  if (!clientId || !assetId) return null;
  const [r] = await q.query<{ id: string; version_no: number; scope: Scope; status: string; start_at: Date | null; end_at: Date | null; total_cents: number; paid_cents: number; renewal_opt_in: boolean; renewal_sent: boolean }>(
    `select id, version_no, scope, status, start_at, end_at, total_cents, paid_cents, renewal_opt_in,
            exists (select 1 from licence_versions c where c.renewal_of = licence_versions.id and c.send_state = 'sent') as renewal_sent
       from licence_versions
      where client_id = $1 and asset_id = $2 and status = 'active' order by version_no desc limit 1`,
    [clientId, assetId],
  );
  return r
    ? { versionId: r.id, versionNo: r.version_no, scope: r.scope, status: r.status, startAt: r.start_at, endAt: r.end_at, totalCents: r.total_cents, paidCents: r.paid_cents, renewalOptIn: r.renewal_opt_in, renewalSent: r.renewal_sent }
    : null;
}

export async function getBriefView(db: Db, briefId: string): Promise<BriefView | null> {
  const brief = await loadBrief(db, briefId);
  if (!brief) return null;
  const [client] = brief.client_id
    ? await db.query<NonNullable<BriefView['client']>>(`select id, name, email, allowed from clients where id = $1`, [brief.client_id])
    : [];
  const [asset] = brief.asset_id
    ? await db.query<NonNullable<BriefView['asset']>>(`select id, title from assets where id = $1`, [brief.asset_id])
    : [];
  const transcript = await latestTranscript(db, briefId);
  const extraction = await latestExtraction(db, briefId);
  const checks = extraction ? { status: extraction.status, reasons: extraction.reasons, ...extraction.raw } : null;
  const licence = await licenceCard(db, brief.client_id, brief.asset_id);
  const version = await currentVersion(db, briefId);
  // review 1: a live quote for this extraction is shown at the card it froze, so Price always matches the invoice.
  const quoted = version && (version.status === 'pending' || version.status === 'active') && extraction && version.extractionId === extraction.id;
  const [frozen] = quoted
    ? await db.query<{ rate_card: RateCard }>(`select rate_card from licence_versions where id = $1`, [version.id])
    : [];
  // Batch 6: a paid quote is priced against the licence it extended, not against itself.
  const paidQuote = quoted && version!.status === 'active';
  // Batch 8 plan fix 5: a renewal deal has no reading; its price is the renewal version's own scope at the card it froze.
  const renewal = brief.source === 'renewal' && version
    ? (await db.query<{ scope: Scope; rate_card: RateCard; parent_no: number | null; parent_scope: Scope | null }>(
      `select v.scope, v.rate_card, p.version_no as parent_no, p.scope as parent_scope
         from licence_versions v left join licence_versions p on p.id = v.renewal_of where v.id = $1`, [version.id]))[0]
    : undefined;
  // B11 item 1: paid use has no price. A social figure here would read as the price of the paid ads.
  const unpriced = !quoted && !renewal && (hasPaidUse(extraction?.reasons) || (brief.confirmed_on_page && extraction?.status !== 'ready'));
  const preview = unpriced ? null : renewal
    ? { ...gap(renewal.scope, null, 0, renewal.rate_card), against: 'empty' as const, parentVersionId: null }
    : await gapPreview(db, brief, checks?.requested ?? null, frozen?.rate_card ?? null, paidQuote ? await parentLicence(db, version!.id) : undefined);
  const locked = await invoiceLocked(db, briefId);
  const inv = version?.invoice;
  const sent = !!inv && !inv.demo && ['sent', 'paid', 'refunded'].includes(inv.state);
  const approved = sent ? (await db.query(`select 1 from approvals where version_id = $1 limit 1`, [version!.id])).length > 0 : false;
  const { upload_path, ...rest } = brief;
  return {
    brief: { ...rest, hasImage: upload_path !== null },
    ...dealState(brief.state, extraction, transcript?.lines.length ?? null, {
      version: version ? { ...version, invoiceState: version.invoice?.state ?? null } : null,
      briefRejectedAt: brief.rejected_at ?? null,
      latestExtractionId: extraction?.id ?? null,
    }),
    notes: brief.state === 'extracted' ? (extraction?.raw.notes ?? []) : [],
    client: client ?? null,
    asset: asset ?? null,
    transcript,
    extraction: unpriced && brief.confirmed_on_page && extraction ? { ...extraction, suggested_price_cents: null } : extraction,
    checks,
    licence,
    cardSource: preview
      ? (renewal ? 'rate card (current when the renewal was opened)' : frozen ? `rate card (frozen with quote v${version!.versionNo})` : licence ? `rate card (frozen v${licence.versionNo})` : 'rate card (current)')
      : null,
    gapPreview: preview,
    version,
    editable: brief.state === 'extracted' && !locked,
    sentBy: sent ? (approved ? 'you' : 'agent') : null,
    proof: version ? await paymentProof(db, version.id) : null,
    renewalParent: renewal?.parent_scope ? { versionNo: renewal.parent_no!, scope: renewal.parent_scope } : null,
    webhookLastReceivedAt: ((await db.query<{ at: Date | null }>(`select max(received_at) as at from webhook_events`))[0]?.at) ?? null,
  };
}

// ---------- creator edits (batch-4 §6 fix 2) ----------

export type BriefEdit = { clientId?: string; assetId?: string; uses?: { optionId: string; quote: string }[] };
export type EditResult = { ok: true; view: BriefView } | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Creator changes the client, the asset and/or the use list. Writes a new extraction (model `creator_edit`),
 * re-runs checks + gap with no AI call. Uses the creator adds must pass the same quote check as the AI's;
 * a use the creator lists without a valid quote is rejected rather than dropped.
 */
export async function editBrief(db: Db, creatorId: string, briefId: string, edit: BriefEdit): Promise<EditResult> {
  const brief = await loadBrief(db, briefId);
  if (!brief || brief.creator_id !== creatorId) return { ok: false, status: 404, error: 'brief not found' };
  if (brief.state === 'awaiting_verification') return { ok: false, status: 409, error: 'waiting for email verification' };
  const transcriptRow = await latestTranscript(db, briefId);
  if (!transcriptRow) return { ok: false, status: 409, error: 'brief has no transcript yet' };
  // Code-review fix 2: uses are only checked against a transcript the creator has confirmed.
  if (!transcriptRow.confirmed_at) return { ok: false, status: 409, error: 'confirm the transcript first' };
  // Batch-5 fix 14: once an invoice is out, scope and recipient are frozen.
  if (await invoiceLocked(db, briefId)) return { ok: false, status: 409, error: 'an invoice is out for this deal; cancel it and re-quote first' };
  const transcript = TranscriptSchema.parse({ lines: transcriptRow.lines });

  if (edit.clientId !== undefined) {
    const c = await db.query(`select 1 from clients where id = $1 and creator_id = $2`, [edit.clientId, creatorId]);
    if (c.length === 0) return { ok: false, status: 404, error: 'client not found' };
  }
  if (edit.assetId !== undefined) {
    const a = await db.query(`select 1 from assets where id = $1 and creator_id = $2`, [edit.assetId, creatorId]);
    if (a.length === 0) return { ok: false, status: 404, error: 'asset not found' };
  }

  // Use list: the edit's, or the current kept uses when only client/asset change.
  const previous = await latestExtraction(db, briefId);
  const uses = edit.uses ?? previous?.raw.kept.map((k) => ({ optionId: k.optionId, quote: k.quote })) ?? [];
  if (edit.uses) {
    for (const u of edit.uses) {
      if (!OPTION_IDS.includes(u.optionId)) return { ok: false, status: 400, error: `"${u.optionId}" is not a rate card option` };
      if (!findQuote(transcript, u.quote)) {
        return { ok: false, status: 400, error: `the quote for "${u.optionId}" must be one whole sentence the client wrote` };
      }
      if (!quoteSupports(u.optionId, findQuote(transcript, u.quote)!.sentence)) {
        return { ok: false, status: 400, error: `the sentence you picked for "${u.optionId}" does not mention it` };
      }
    }
  }

  const updated: BriefRow = { ...brief, client_id: edit.clientId ?? brief.client_id, asset_id: edit.assetId ?? brief.asset_id };
  const briefUpdate = edit.clientId !== undefined || edit.assetId !== undefined;

  const licence = await activeLicence(db, updated.client_id, updated.asset_id);
  // review (review follow-up): only a PATCH that sends uses is the creator reviewing the text. Changing just the
  // client or photo re-runs the checks with tripwire/negation still blocking.
  const checks = runChecks({ transcript, extraction: { uses }, current: licence?.scope ?? null, reviewedByCreator: edit.uses !== undefined });
  await persistExtraction(db, updated, transcriptRow.id, {
    briefUpdate,
    status: checks.status,
    reasons: checks.reasons,
    stored: { kept: checks.kept, dropped: checks.dropped, requested: checks.requested, notes: checks.notes },
    model: 'creator_edit',
    // The AI's struck-out suggestion stays visible after a creator edit; it is still never priced.
    suggested: previous?.suggested_price_cents ?? null,
    question: checks.clarifyingQuestion,
    rawModel: { edit },
  });
  await db.query(`insert into events (creator_id, kind, detail) values ($1, 'brief.edited', $2)`, [creatorId, JSON.stringify({ briefId, edit })]);
  return { ok: true, view: (await getBriefView(db, briefId))! };
}

// ---------- decide stub (batch-4 §6 fix 3; batch 5 replaces the handler) ----------

export async function decideStub(db: Db, creatorId: string, briefId: string, action: 'approve' | 'reject', typedTotalCents: number | null) {
  const brief = await loadBrief(db, briefId);
  if (!brief || brief.creator_id !== creatorId) return null;
  const [row] = await db.query<{ id: string; created_at: Date }>(
    `insert into events (creator_id, kind, detail) values ($1, 'decide_stub', $2) returning id, created_at`,
    [creatorId, JSON.stringify({ briefId, action, typedTotalCents })],
  );
  return row!;
}
