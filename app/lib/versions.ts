// Licence version drafts (batch-5 §1, fixes 1, 7). One pending version per extraction: a duplicate request
// reuses it, so the invoice_number (derived from the version id) is the same and PayPal makes one invoice.
import type { Queryable } from '../db/client';
import { activeLicence, creatorCard, gapPreview, latestExtraction, loadBrief, type DealVersion, currentVersion } from './briefs';
import { contentHash } from './hash';
import { scopeOptionIds, type Scope } from './pricing';
import { hasPaidUse, PAID_USE_REFUSAL } from './reasons';

export type VersionRow = {
  id: string;
  creator_id: string;
  client_id: string;
  asset_id: string;
  parent_id: string | null;
  version_no: number;
  scope: Scope;
  total_cents: number;
  content_hash: string;
  status: string;
  brief_id: string;
  extraction_id: string | null; // null on a renewal
  send_state: DealVersion['sendState'];
  rejected_at: Date | null;
  /** Batch 8: the licence this version renews (null for every other version). */
  renewal_of: string | null;
};

/** Fix 7: sha256 of canonical JSON (sorted keys) of what the client is asked to pay for. */
export function versionHash(v: { scope: Scope; totalCents: number; assetId: string; clientId: string; parentId: string | null }): string {
  return contentHash({ scope: v.scope, totalCents: v.totalCents, assetId: v.assetId, clientId: v.clientId, parentId: v.parentId });
}

export const hashOf = (v: VersionRow) =>
  versionHash({ scope: v.scope, totalCents: v.total_cents, assetId: v.asset_id, clientId: v.client_id, parentId: v.parent_id });

/**
 * `UR-` + 22 hex of the version UUID (spec Y6, 25 chars). A retry after PayPal already holds a cancelled or
 * deleted invoice under that number uses 20 hex + a 2-hex attempt counter, still 25 chars and still derived.
 */
export const MAX_INVOICE_ATTEMPTS = 254;

export function invoiceNumberFor(versionId: string, attempt = 0): string {
  const hex = versionId.replace(/-/g, '').toLowerCase();
  if (attempt === 0) return `UR-${hex.slice(0, 22)}`;
  // B5 review 6: the suffix must never equal attempt 0's own last two hex digits, and never wrap.
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_INVOICE_ATTEMPTS) throw new Error('too many invoice attempts for this quote');
  const own = parseInt(hex.slice(20, 22), 16);
  const suffix = attempt < own ? attempt : attempt + 1; // skips `own`; attempt 254 -> at most 255
  return `UR-${hex.slice(0, 20)}${suffix.toString(16).padStart(2, '0')}`;
}

export async function loadVersion(q: Queryable, versionId: string, forUpdate = false): Promise<VersionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return null;
  const [r] = await q.query<VersionRow>(`select * from licence_versions where id = $1${forUpdate ? ' for update' : ''}`, [versionId]);
  return r ?? null;
}

/** Option ids this version adds over its parent (all of them for a v1). R4 runs on these. */
export async function newOptionIds(q: Queryable, v: VersionRow): Promise<string[]> {
  if (!v.parent_id) return scopeOptionIds(v.scope);
  const [p] = await q.query<{ scope: Scope }>(`select scope from licence_versions where id = $1`, [v.parent_id]);
  const had = new Set<string>(p ? scopeOptionIds(p.scope) : []);
  return scopeOptionIds(v.scope).filter((id) => !had.has(id));
}

export type VersionResult = { ok: true; version: VersionRow; created: boolean } | { ok: false; status: 404 | 409; error: string; code?: string };

/** review 3: the seeded Studio Portrait is a generated gradient, not a photo. A private real photo still sells. */
export const PLACEHOLDER_ASSET_KEY = 'imani/studio-portrait/original.jpg';

export type SaleRefusal = { status: 409; error: string; code: string };

/**
 * B11 item 1 and review 3: what no first send may carry. Reads the quote's own extraction, including the notes an edit made
 * before B11 could turn paid words into. A renewal has no extraction, so only its photo is checked.
 */
export async function saleRefusal(q: Queryable, v: { asset_id: string; extraction_id: string | null }): Promise<SaleRefusal | null> {
  const [x] = v.extraction_id
    ? await q.query<{ reasons: string[]; raw: { notes?: string[] } }>(`select reasons, raw from extractions where id = $1`, [v.extraction_id])
    : [];
  if (x && (hasPaidUse(x.reasons) || hasPaidUse(x.raw.notes))) return { status: 409, error: PAID_USE_REFUSAL, code: 'paid_use_unpriced' };
  const [placeholder] = await q.query(`select 1 from assets where id = $1 and key_original = $2`, [v.asset_id, PLACEHOLDER_ASSET_KEY]);
  return placeholder ? { status: 409, error: 'This photo is not for sale.', code: 'asset_not_for_sale' } : null;
}

/**
 * Pending version for the brief's latest extraction: reused when it exists (fix 1), otherwise created from
 * gap(): parent = active version, combined scope, frozen card (parent's for vN, current for v1), gap total.
 */
export async function pendingVersionFor(q: Queryable, briefId: string): Promise<VersionResult> {
  const brief = await loadBrief(q, briefId);
  if (!brief) return { ok: false, status: 404, error: 'brief not found' };
  if (brief.state !== 'extracted') return { ok: false, status: 409, error: 'the request has not been read yet' };
  if (!brief.client_id || !brief.asset_id) return { ok: false, status: 409, error: 'pick the client and the photo first' };
  const extraction = await latestExtraction(q, briefId);
  if (!extraction) return { ok: false, status: 409, error: 'the request has not been read yet' };

  const [existing] = await q.query<VersionRow>(`select * from licence_versions where extraction_id = $1 and status = 'pending'`, [extraction.id]);
  if (existing) return { ok: true, version: existing, created: false };
  // A rejected or cancelled quote for this extraction is not reopened by a repeat request.
  const latest = await currentVersion(q, briefId);
  if (latest && latest.extractionId === extraction.id && (latest.status === 'draft' || latest.status === 'superseded')) {
    return { ok: false, status: 409, error: latest.status === 'draft' ? 'this quote was rejected' : 'this quote was cancelled; edit the deal to re-quote' };
  }
  // Batch 6: a paid (or refunded) quote is never re-quoted from the same request; a new edit makes the next version.
  if (latest && latest.extractionId === extraction.id && ['active', 'refunded', 'expired'].includes(latest.status)) {
    return { ok: false, status: 409, error: latest.status === 'active' ? 'this quote is paid' : `this quote is ${latest.status}` };
  }

  // No new quote for what could not be sent. claim() in send.ts enforces the same refusal on a quote that already exists.
  const refused = await saleRefusal(q, { asset_id: brief.asset_id, extraction_id: extraction.id });
  if (refused) return { ok: false, ...refused };

  const preview = await gapPreview(q, brief, extraction.raw.requested);
  if (!preview) return { ok: false, status: 409, error: 'nothing is priced yet' };
  if (preview.refused) return { ok: false, status: 409, error: 'the client already holds everything requested; there is nothing to sell' };
  const licence = await activeLicence(q, brief.client_id, brief.asset_id);
  const rateCard = licence ? licence.rateCard : await creatorCard(q, brief.creator_id);
  const parentNo = licence
    ? ((await q.query<{ version_no: number }>(`select version_no from licence_versions where id = $1`, [licence.versionId]))[0]?.version_no ?? 0)
    : 0;
  const hash = versionHash({ scope: preview.combined, totalCents: preview.totalCents, assetId: brief.asset_id, clientId: brief.client_id, parentId: licence?.versionId ?? null });

  const rows = await q.query<VersionRow>(
    `insert into licence_versions
       (creator_id, client_id, asset_id, parent_id, version_no, scope, rate_card, total_cents, paid_cents, content_hash, status,
        brief_id, extraction_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, 'pending', $10, $11)
     on conflict (extraction_id) where status = 'pending' do nothing
     returning *`,
    [brief.creator_id, brief.client_id, brief.asset_id, licence?.versionId ?? null, parentNo + 1, JSON.stringify(preview.combined),
      JSON.stringify(rateCard), preview.totalCents, hash, brief.id, extraction.id],
  );
  if (rows[0]) return { ok: true, version: rows[0], created: true };
  const [raced] = await q.query<VersionRow>(`select * from licence_versions where extraction_id = $1 and status = 'pending'`, [extraction.id]);
  return raced ? { ok: true, version: raced, created: false } : { ok: false, status: 409, error: 'could not create the quote' };
}
