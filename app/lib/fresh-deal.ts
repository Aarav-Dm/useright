// B9 9.2: which sample a fresh demo deal uses. The first one the client has not already bought, so the deal always has
// something new to price, even after the print add-on was paid on camera.
// review 4, review 8: an unsettled sample deal (a request, or a quote with an unpaid invoice) is reused, never doubled, so
// repeat clicks send no new invoice and do not drain the R3 rolling cap. Security review guards: only a sample's exact
// text matches, so a real request or the Paid ads ask is never handed back; a reuse runs no model, agent, Retry or new
// pay token; the oldest open deal wins.
import { SAMPLES, type Sample } from '@/components/creator/request-samples';
import type { Queryable } from '../db/client';
import { intake, type IntakeDeps } from './intake';
import { lockCreator } from './policy';
import type { Scope } from './pricing';

const ORDER: { key: string; channel: string }[] = [
  { key: 'print', channel: 'print' },
  { key: 'social', channel: 'social' },
  { key: 'billboard', channel: 'billboard' },
];

export type FreshDeal = { ok: true; briefId: string; label: string; ready: boolean; reused: boolean } | { ok: false; status: number; error: string };

type Pick = { kind: 'reuse'; briefId: string; label: string } | { kind: 'new'; sample: Sample; clientId: string; assetId: string } | { kind: 'none' };

async function pick(q: Queryable, creatorId: string): Promise<Pick> {
  const rows: { sample: Sample; clientId: string; assetId: string; held: boolean; openId: string | null }[] = [];
  for (const { key, channel } of ORDER) {
    const s = SAMPLES.find((x) => x.key === key)!;
    const [client] = await q.query<{ id: string }>(`select id from clients where creator_id = $1 and lower(email) = $2`, [creatorId, s.clientEmail]);
    const [asset] = await q.query<{ id: string }>(`select id from assets where creator_id = $1 and title = $2`, [creatorId, s.assetTitle]);
    if (!client || !asset) continue;
    const held = await q.query<{ scope: Scope }>(
      `select scope from licence_versions where client_id = $1 and asset_id = $2 and status = 'active'`, [client.id, asset.id]);
    // Settled means paid, rejected or cancelled: the quote left 'pending', or the request was rejected before any quote.
    const [open] = await q.query<{ id: string }>(
      `select b.id from briefs b
        where b.creator_id = $1 and b.client_id = $2 and b.asset_id = $3 and b.source = 'paste' and b.raw = $4 and b.rejected_at is null
          and (exists (select 1 from licence_versions v where v.brief_id = b.id and v.status = 'pending')
               or not exists (select 1 from licence_versions v where v.brief_id = b.id))
        order by b.created_at, b.id limit 1`, [creatorId, client.id, asset.id, s.text]);
    rows.push({ sample: s, clientId: client.id, assetId: asset.id, held: held.some((h) => (h.scope.channels as string[]).includes(channel)), openId: open?.id ?? null });
  }
  // A billboard only leaves on the creator's typed approval, so it cannot drain the cap; one left open after filming
  // must not stop the next sample. It is reused only when it is the next sample anyway.
  const r = rows.find((x) => x.openId && x.sample.key !== 'billboard') ?? rows.find((x) => !x.held);
  if (!r) return { kind: 'none' };
  return r.openId ? { kind: 'reuse', briefId: r.openId, label: r.sample.label } : { kind: 'new', sample: r.sample, clientId: r.clientId, assetId: r.assetId };
}

const LOST_RACE = 'another click added this deal';

export async function startFreshDeal(d: IntakeDeps, creatorId: string): Promise<FreshDeal> {
  const first = await pick(d.db, creatorId); // before intake, so a reuse makes no model call
  if (first.kind === 'none') return { ok: false, status: 409, error: 'Every sample is already licensed, so a fresh deal has nothing new to price.' };
  if (first.kind === 'reuse') return { ok: true, briefId: first.briefId, label: first.label, ready: false, reused: true };
  const s = first.sample;
  // The choice is made again under the creator lock, in the transaction that stores the request.
  const r = await intake(d, { source: 'paste', clientId: first.clientId, assetId: first.assetId, text: s.text, fixture: s.fixture }, { creator: true, sessionSlug: 'imani' }, async (tx) => {
    await lockCreator(tx, creatorId);
    const now = await pick(tx, creatorId);
    return now.kind === 'new' && now.sample.key === s.key ? null : { ok: false, status: 409, error: LOST_RACE };
  });
  if (r.ok) return { ok: true, briefId: r.briefId, label: s.label, ready: r.extraction?.status === 'ready', reused: false };
  if (r.error !== LOST_RACE) return { ok: false, status: r.status, error: r.error };
  const again = await pick(d.db, creatorId);
  if (again.kind === 'reuse') return { ok: true, briefId: again.briefId, label: again.label, ready: false, reused: true };
  return { ok: false, status: 409, error: 'The samples changed during this click. Try again.' };
}
