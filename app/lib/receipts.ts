// Rights receipts (batch-6 §6, fix 16). Body in receipts.body jsonb; public_id is a random 32-byte token, never a UUID.
// A revocation is a new receipt row with status `refunded`. The public page shows the version's live status.
import type { Queryable } from '../db/client';
import { paymentProof, type PaymentProof } from './proof';
import { licensedFile } from './access';
import { scopeParts } from './format';
import type { Scope } from './pricing';
import { maskEmail, newToken, TOKEN_RE } from './tokens';

export type ReceiptBody = {
  /** Batch 8: 'expiry' is the Expired receipt the tick issues when a term ends without a paid renewal. */
  kind: 'grant' | 'revocation' | 'expiry';
  licensor: { name: string };
  /** Batch-6 review F15: `email` is the invoice's client; `payerEmail` only what PayPal itself reported (null = not provided). */
  licensee: { name: string; email: string | null; payerEmail: string | null };
  asset: { title: string; file: 'print' | 'web'; fileLabel: string; sha256: string };
  scope: { words: string; channels: string[]; territory: string; durationMonths: number; exclusive: boolean };
  startAt: string | null;
  endAt: string | null;
  renewalDate: string | null;
  priceCents: number;
  currency: 'USD';
  paypalTransactionId: string;
  paypalInvoiceId: string | null;
  invoiceNumber: string | null;
  versionNo: number;
  parentVersionNo: number | null;
  status: string;
  collaborator: string;
  issuedAt: string;
  revokedReason?: string;
};

const COLLABORATOR = 'None recorded';

type Src = {
  creator_name: string; client_name: string; client_email: string; title: string; scope: Scope; start_at: Date | null; end_at: Date | null;
  total_cents: number; version_no: number; parent_no: number | null; creator_id: string;
};

async function source(tx: Queryable, versionId: string): Promise<Src> {
  const [r] = await tx.query<Src>(
    `select cr.name as creator_name, c.name as client_name, c.email as client_email, a.title, v.scope, v.start_at, v.end_at,
            v.total_cents, v.version_no, p.version_no as parent_no, v.creator_id
       from licence_versions v join creators cr on cr.id = v.creator_id join clients c on c.id = v.client_id
       join assets a on a.id = v.asset_id left join licence_versions p on p.id = v.parent_id
      where v.id = $1`, [versionId]);
  return r!;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const words = (s: Scope) => scopeParts(s).map((p) => p.label).join(', ');
const scopeOf = (s: Scope): ReceiptBody['scope'] => ({ words: words(s), channels: [...s.channels], territory: s.territory, durationMonths: s.durationMonths, exclusive: s.exclusive });

/** The grant receipt body (also used by the seed, F9, so seeded and live receipts share one producer). */
export function grantReceiptBody(s: {
  creatorName: string; clientName: string; clientEmail: string; payerEmail: string | null; title: string; scope: Scope;
  startAt: Date | null; endAt: Date | null; versionNo: number; parentVersionNo: number | null;
}, g: { txnId: string; amountCents: number; fileSha256: string; paypalInvoiceId: string | null; invoiceNumber: string | null }, issuedAt: Date = new Date()): ReceiptBody {
  const f = licensedFile(s.scope);
  return {
    kind: 'grant',
    licensor: { name: s.creatorName },
    licensee: { name: s.clientName, email: maskEmail(s.clientEmail), payerEmail: maskEmail(s.payerEmail) },
    asset: { title: s.title, file: f.file, fileLabel: f.label, sha256: g.fileSha256 },
    scope: scopeOf(s.scope),
    startAt: iso(s.startAt), endAt: iso(s.endAt), renewalDate: iso(s.endAt), // renewal = end until batch 8
    priceCents: g.amountCents, currency: 'USD',
    paypalTransactionId: g.txnId, paypalInvoiceId: g.paypalInvoiceId, invoiceNumber: g.invoiceNumber,
    versionNo: s.versionNo, parentVersionNo: s.parentVersionNo,
    status: 'active',
    collaborator: COLLABORATOR,
    issuedAt: issuedAt.toISOString(),
  };
}

export async function issueGrantReceipt(tx: Queryable, g: { versionId: string; txnId: string; amountCents: number; fileSha256: string; paypalInvoiceId: string; invoiceNumber: string; payerEmail: string | null }): Promise<{ publicId: string }> {
  const s = await source(tx, g.versionId);
  const body = grantReceiptBody({
    creatorName: s.creator_name, clientName: s.client_name, clientEmail: s.client_email, payerEmail: g.payerEmail, title: s.title, scope: s.scope,
    startAt: s.start_at, endAt: s.end_at, versionNo: s.version_no, parentVersionNo: s.parent_no,
  }, g);
  const publicId = newToken();
  await tx.query(`insert into receipts (creator_id, version_id, status, public_id, body) values ($1, $2, 'active', $3, $4)`,
    [s.creator_id, g.versionId, publicId, JSON.stringify(body)]);
  return { publicId };
}

// ---------- legacy bodies (F9) ----------

type LegacyBody = {
  licensor?: { name?: string };
  licensee?: { name?: string; email?: string | null; paypalPayer?: string | null; payerEmail?: string | null };
  asset?: { title?: string; fileHash?: string; sha256?: string; file?: string; fileLabel?: string };
  scope?: Partial<Scope> & { words?: string };
  startAt?: string | null; endAt?: string | null; renewalDate?: string | null;
  price?: { totalCents?: number; currency?: string };
  priceCents?: number;
  paypalTransactionId?: string;
  version?: number; versionNo?: number;
  status?: string;
  files?: { print?: string };
};

const isScope = (s: unknown): s is Scope =>
  !!s && typeof s === 'object' && Array.isArray((s as Scope).channels) && typeof (s as Scope).territory === 'string' && typeof (s as Scope).durationMonths === 'number';

/**
 * Batch-6 review F9: every stored body is read through this before it is shown or copied into a revocation. A body
 * from the batch-2 seed (no `kind`, `price.totalCents`, `version`, raw scope object, unmasked emails, asset UUID) is
 * mapped onto the current shape; emails are masked whatever the body's age. Unknown fields are dropped.
 */
export type ReceiptFallback = { totalCents: number; scope: Scope; versionNo: number };

export function normalizeReceiptBody(raw: unknown, fallbackIssuedAt: Date, version?: ReceiptFallback): ReceiptBody {
  const b = (raw ?? {}) as Partial<ReceiptBody> & LegacyBody;
  if (b.kind === 'grant' || b.kind === 'revocation' || b.kind === 'expiry') {
    const body = b as ReceiptBody;
    return { ...body, licensee: { ...body.licensee, email: maskEmail(body.licensee?.email), payerEmail: maskEmail(body.licensee?.payerEmail) } };
  }
  // Fix round 2 (review #11): a field the legacy body lacks comes from the licence version itself, never a made-up 0 / v1.
  const scope: Scope | null = isScope(b.scope) ? (b.scope as Scope) : version && isScope(version.scope) ? version.scope : null;
  const print = b.files?.print === 'delivered' || (scope ? licensedFile(scope).file === 'print' : false);
  const legacyLicensee = b.licensee as LegacyBody['licensee'];
  return {
    kind: 'grant',
    licensor: { name: b.licensor?.name ?? '' },
    licensee: { name: legacyLicensee?.name ?? '', email: maskEmail(legacyLicensee?.email), payerEmail: maskEmail(legacyLicensee?.payerEmail ?? legacyLicensee?.paypalPayer) },
    asset: {
      title: b.asset?.title ?? '', file: print ? 'print' : 'web', fileLabel: print ? 'Print-resolution file' : 'Web file',
      sha256: b.asset?.sha256 ?? b.asset?.fileHash ?? '',
    },
    scope: scope ? scopeOf(scope) : { words: b.scope?.words ?? '', channels: [], territory: '', durationMonths: 0, exclusive: false },
    startAt: b.startAt ?? null, endAt: b.endAt ?? null, renewalDate: b.renewalDate ?? b.endAt ?? null,
    priceCents: typeof b.priceCents === 'number' ? b.priceCents : typeof b.price?.totalCents === 'number' ? b.price.totalCents : version?.totalCents ?? 0,
    currency: 'USD',
    paypalTransactionId: b.paypalTransactionId ?? '',
    paypalInvoiceId: null, invoiceNumber: null,
    versionNo: typeof b.versionNo === 'number' ? b.versionNo : typeof b.version === 'number' ? b.version : version?.versionNo ?? 1,
    parentVersionNo: null,
    status: b.status ?? 'active',
    collaborator: COLLABORATOR,
    issuedAt: fallbackIssuedAt.toISOString(),
  };
}

/**
 * A new receipt row with status refunded, copied from the version's grant receipt. No-op when there was no grant.
 * F9: a legacy (seeded) body has no `kind`; any active receipt of the version is its grant.
 */
export async function issueRevocationReceipt(tx: Queryable, versionId: string, reason: string): Promise<{ publicId: string } | null> {
  return copyGrantReceipt(tx, versionId, 'revocation', 'refunded', reason);
}

/**
 * Batch 8 §3: a licence whose term ended without a paid renewal gets two receipts, both copied from its grant
 * receipt and stored with status `expired`: an "Expired" receipt and a revocation receipt (downloads stopped).
 */
export async function issueExpiryReceipts(tx: Queryable, versionId: string): Promise<{ expired: string; revocation: string } | null> {
  const expired = await copyGrantReceipt(tx, versionId, 'expiry', 'expired', 'The licence term ended without a paid renewal.');
  if (!expired) return null;
  const revocation = await copyGrantReceipt(tx, versionId, 'revocation', 'expired', 'The licence term ended; downloads stopped.');
  return { expired: expired.publicId, revocation: revocation!.publicId };
}

async function copyGrantReceipt(tx: Queryable, versionId: string, kind: 'revocation' | 'expiry', status: 'refunded' | 'expired', reason: string): Promise<{ publicId: string } | null> {
  const [g] = await tx.query<{ creator_id: string; body: unknown; created_at: Date; total_cents: number; scope: Scope; version_no: number }>(
    `select r.creator_id, r.body, r.created_at, v.total_cents, v.scope, v.version_no from receipts r join licence_versions v on v.id = r.version_id
      where r.version_id = $1 and r.status = 'active' and coalesce(r.body->>'kind', 'grant') = 'grant'
      order by r.seq desc limit 1`, [versionId]);
  if (!g) return null;
  const body: ReceiptBody = { ...normalizeReceiptBody(g.body, new Date(g.created_at), { totalCents: g.total_cents, scope: g.scope, versionNo: g.version_no }), kind, status, issuedAt: new Date().toISOString(), revokedReason: reason };
  const publicId = newToken();
  await tx.query(`insert into receipts (creator_id, version_id, status, public_id, body) values ($1, $2, $3, $4, $5)`,
    [g.creator_id, versionId, status, publicId, JSON.stringify(body)]);
  return { publicId };
}

export type ReceiptView = {
  body: ReceiptBody; liveStatus: 'active' | 'superseded' | 'expired' | 'refunded' | 'pending' | 'draft'; issuedAt: string;
  /** Batch 8 §2: the client's renewal choice on the licence, read live (it can change after payment). */
  renewalOptIn: boolean;
  /** The creator's zone, the one the term was computed in: every date on the receipt reads in it, whatever the server's zone. */
  timeZone: string;
  /** B12 D1: the PayPal evidence behind this licence (null for a seeded one). */
  proof: PaymentProof | null;
};

/** /r/:id: the receipt and the licence's status right now. Never returns ids beyond what the body holds. */
export async function receiptView(q: Queryable, publicId: string, now: Date = new Date()): Promise<ReceiptView | null> {
  if (!TOKEN_RE.test(publicId)) return null;
  const [r] = await q.query<{ version_id: string; body: unknown; status: ReceiptView['liveStatus']; end_at: Date | null; created_at: Date; total_cents: number; scope: Scope; version_no: number; renewal_opt_in: boolean; timezone: string | null }>(
    `select r.version_id, r.body, v.status, v.end_at, r.created_at, v.total_cents, v.scope, v.version_no, v.renewal_opt_in, s.timezone
       from receipts r join licence_versions v on v.id = r.version_id left join creator_settings s on s.creator_id = v.creator_id where r.public_id = $1`, [publicId]);
  if (!r) return null;
  const live = r.status === 'active' && r.end_at && new Date(r.end_at).getTime() <= now.getTime() ? 'expired' : r.status;
  return { body: normalizeReceiptBody(r.body, new Date(r.created_at), { totalCents: r.total_cents, scope: r.scope, versionNo: r.version_no }), liveStatus: live, issuedAt: new Date(r.created_at).toISOString(), renewalOptIn: r.renewal_opt_in, timeZone: r.timezone ?? 'America/New_York', proof: await paymentProof(q, r.version_id) };
}

export async function latestReceiptId(q: Queryable, versionId: string): Promise<string | null> {
  const [r] = await q.query<{ public_id: string }>(`select public_id from receipts where version_id = $1 order by seq desc limit 1`, [versionId]);
  return r?.public_id ?? null;
}
