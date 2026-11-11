// B12 D2: a read-only JSON door for a buyer's agent. A quote for a named public photo and use, priced by gap() from the
// creator's rate card, and a receipt check by public id and file hash. Neither call writes anything but a rate-limit
// hit: no version, no invoice, no file. Asking for a use goes through the existing public intake (POST /api/intake).
import type { Queryable } from '../db/client';
import { isIP } from 'node:net';
import { creatorCard } from './briefs';
import { optionLabel, scopeParts } from './format';
import { gap } from './gap';
import { CHANNELS, DURATIONS, TERRITORIES, type Channel, type DurationMonths, type Scope, type Territory } from './pricing';
import { PAID_PROMO_TRIPWIRES } from './reasons';
import { normalizeReceiptBody, receiptView } from './receipts';
import { TOKEN_RE } from './tokens';

/** Per-IP hits per hour across both GET routes; a route file may not export it (Next allows only route fields). */
export const AGENT_DOOR_LIMIT_PER_HOUR = 120;

/** The trusted ingress appends/overwrites the final hop; caller-supplied prefixes must not create new budgets. */
export function agentIp(headers: Headers): string {
  const ip = headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  return ip && isIP(ip) ? ip : 'unknown';
}

export type DoorResult = { status: number; body: Record<string, unknown> };

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): DoorResult => ({ status, body: { code, error, ...extra } });

/** `use` is a comma list of channels; `territory` and `months` default to US and 6. Paid promotion is refused with no figure. */
export async function agentQuote(q: Queryable, creatorId: string, p: { photo?: string | null; use?: string | null; territory?: string | null; months?: string | null }): Promise<DoorResult> {
  const words = (p.use ?? '').split(',').map((w) => w.trim()).filter(Boolean);
  // B11 rule: paid promotion has no rate-card line, so it gets no price anywhere, this door included.
  if (words.some((w) => PAID_PROMO_TRIPWIRES.some((t) => t.pattern.test(w)))) {
    return fail(422, 'paid_use_unpriced', 'Paid promotion is not on this rate card, so it has no price. Ask for an organic use instead.', { channels: CHANNELS });
  }
  const unknown = words.filter((w) => !(CHANNELS as readonly string[]).includes(w));
  if (!words.length || unknown.length) return fail(400, 'bad_use', 'Unknown or missing use. Choose from the supported channels.', { channels: CHANNELS });
  const territory = p.territory ?? 'US';
  if (!(TERRITORIES as readonly string[]).includes(territory)) return fail(400, 'bad_territory', 'Unknown territory.', { territories: TERRITORIES });
  const months = Number(p.months ?? '6');
  if (!(DURATIONS as readonly number[]).includes(months)) return fail(400, 'bad_months', 'Unknown duration.', { months: DURATIONS });
  const photo = (p.photo ?? '').trim();
  const [asset] = photo
    ? await q.query<{ id: string; title: string }>(
      `select id, title from assets where creator_id = $1 and is_public and (id::text = $2 or lower(title) = lower($2)) limit 1`, [creatorId, photo])
    : [];
  if (!asset) return fail(404, 'no_photo', 'No public photo with that id or title.');

  const scope: Scope = { channels: [...new Set(words)] as Channel[], territory: territory as Territory, durationMonths: months as DurationMonths, exclusive: false };
  const g = gap(scope, null, 0, await creatorCard(q, creatorId));
  return {
    status: 200,
    body: {
      photo: asset,
      scope: scopeParts(g.combined).map((x) => x.label).join(', '),
      lines: g.lines.map((l) => ({ option: l.optionId, label: optionLabel(l.optionId), cents: l.cents })),
      totalCents: g.totalCents,
      currency: 'USD',
      basis: 'A first licence at the creator\'s current rate card. A client who already holds a licence on this photo pays only the gap, priced when the request is read.',
      invoiced: false,
      request: { method: 'POST', path: '/api/intake', body: { source: 'portfolio', assetId: asset.id, email: '<buyer email>', name: '<buyer name>', text: '<the use, in words>' } },
    },
  };
}

/** True when the receipt exists and its file fingerprint is the given SHA-256. Returns only what /r/:id already shows. */
export async function verifyReceipt(q: Queryable, id: string | null, sha256: string | null): Promise<DoorResult> {
  if (!id) return fail(400, 'bad_id', 'Give the receipt id from /r/<id>.');
  const want = sha256?.trim().toLowerCase() ?? '';
  if (!/^[a-f0-9]{64}$/.test(want)) return fail(400, 'bad_hash', 'Give the file SHA-256 as 64 hexadecimal characters.');
  const [hash] = TOKEN_RE.test(id) ? await q.query<{ asset: unknown; created_at: Date }>(
    `select body->'asset' as asset, created_at from receipts where public_id = $1`, [id]) : [];
  if (!hash || want !== normalizeReceiptBody({ asset: hash.asset }, new Date(hash.created_at)).asset.sha256.toLowerCase()) return fail(404, 'no_receipt', 'No matching receipt.');
  const r = await receiptView(q, id);
  if (!r) return fail(404, 'no_receipt', 'No matching receipt.');
  const b = r.body;
  return {
    status: 200,
    body: {
      receipt: id,
      kind: b.kind,
      status: r.liveStatus,
      licenceValid: r.liveStatus === 'active' && b.kind === 'grant',
      photo: b.asset.title,
      scope: b.scope.words,
      startAt: b.startAt,
      endAt: b.endAt,
      sha256: b.asset.sha256,
      sha256Matches: true,
      demo: b.paypalTransactionId.startsWith('SEED-'),
      paypal: r.proof ? { invoiceId: r.proof.paypalInvoiceId, lastCheck: r.proof.lastCheck, webhook: r.proof.webhook } : null,
    },
  };
}
