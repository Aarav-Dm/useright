// Batch 7C phase 2: the creator overview, read only. Built from the existing read models (listDeals, listAsk,
// listAlerts, listLedger) plus one read of the payments table. It adds no pricing, policy or payment logic.
// review B7C-2 findings 1 and 2: money comes from one place, `listPaidVersions`, used by Overview, Ledger totals and
// Portfolio alike, so every page tells the same story. Seeded payments (`SEED-...`) are kept apart from
// PayPal-verified money, and a licence revoked only because an earlier licence it built on was refunded keeps its
// money (it is not a refund).
import type { Db } from '../db/client';
import { listDeals, type DealRow } from './deals';
import { listAlerts, listAsk, listLedger, type AskAlert, type AskItem, type LedgerRow } from './ledger';

export type Money = { liveCents: number; demoCents: number; liveCount: number; demoCount: number };
export type Overview = {
  /**
   * earned: paid versions whose own payment was not refunded (it includes `revokedKept`).
   * revokedKept: versions revoked because an earlier licence was refunded; PayPal kept their money.
   * refunded: versions whose own payment was refunded or reversed in PayPal.
   */
  totals: { earned: Money; pending: Money; refunded: Money; revokedKept: Money };
  /**
   * B12 E6: the headline. caught = requests the agent priced as use beyond the licence (a gap above $0), live and
   * seeded counted apart; invoicedCents = PayPal-verified plus unpaid plus refunded live money; recoveredCents = earned live.
   */
  headline: { caught: number; caughtDemo: number; invoicedCents: number; recoveredCents: number };
  /** review B7C-2 finding 5: payments partly refunded in PayPal (`refund_partial` events); their full amount stays in Earned. */
  partlyRefunded: number;
  /**
   * review B7C-2 finding 2, each item counted once: approvals = rule-stopped quotes that wait for typed approval;
   * blocked = hard blocks that need a deal fix; checks = requests to check; failed = sends not confirmed.
   */
  waiting: { approvals: number; blocked: number; blockedBriefId: string | null; checks: number; failed: number };
  /** The newest payment alerts (`listAlerts`, last 20). Alerts have no resolved state, so they are not "waiting". */
  alertsShown: number;
  unpaid: DealRow[];
  ask: AskItem[];
  alerts: AskAlert[];
  recent: LedgerRow[];
  /**
   * versionId -> its receipts. review B7C-2 finding 3: a grant row opens the grant receipt and a revoked row the
   * revocation receipt, even after a refund made the revocation the newest one.
   */
  receipts: Record<string, { grant?: string; revocation?: string }>;
};

/** One row per paid licence version (its latest payment), with how it ended. */
export type PaidVersion = {
  versionId: string;
  assetId: string;
  status: string;
  amountCents: number;
  /** Seeded payment (`SEED-V1`, `SEED-DEMO-...`): display only, never PayPal evidence. */
  demo: boolean;
  /** Its own payment was refunded or reversed in PayPal. */
  refunded: boolean;
  /** Revoked because an earlier licence it built on was refunded; its own money was kept. */
  revokedKept: boolean;
};

export async function listPaidVersions(db: Db, creatorId: string): Promise<PaidVersion[]> {
  const rows = await db.query<{ version_id: string; asset_id: string; status: string; amount_cents: number; paypal_txn_id: string; cascaded: boolean | null }>(
    `with paid as (
       select distinct on (p.version_id) p.version_id, p.amount_cents, p.paypal_txn_id
         from payments p
        where p.creator_id = $1 and p.paypal_txn_id is not null
        order by p.version_id, p.seq desc
     ), rev as (
       select distinct on (e.detail->>'versionId') e.detail->>'versionId' as version_id, (e.detail ? 'causedByTxnId') as cascaded
         from events e
        where e.creator_id = $1 and e.kind = 'revoked'
        order by e.detail->>'versionId', e.created_at desc, e.seq desc
     )
     select paid.version_id, v.asset_id, v.status::text as status, paid.amount_cents, paid.paypal_txn_id, rev.cascaded
       from paid
       join licence_versions v on v.id = paid.version_id
       left join rev on rev.version_id = paid.version_id::text
      order by v.created_at`, [creatorId]);
  return rows.map((r) => {
    const revokedKept = r.status === 'refunded' && r.cascaded === true;
    return {
      versionId: r.version_id, assetId: r.asset_id, status: r.status, amountCents: r.amount_cents,
      demo: r.paypal_txn_id.startsWith('SEED-'),
      refunded: r.status === 'refunded' && !revokedKept,
      revokedKept,
    };
  });
}

const empty = (): Money => ({ liveCents: 0, demoCents: 0, liveCount: 0, demoCount: 0 });
function add(m: Money, cents: number | null, demo: boolean) {
  if (cents === null) return;
  if (demo) { m.demoCents += cents; m.demoCount += 1; } else { m.liveCents += cents; m.liveCount += 1; }
}

/** Earned, refunded and revoked-but-kept money from the paid versions. */
export function moneyTotals(paid: PaidVersion[]) {
  const earned = empty();
  const refunded = empty();
  const revokedKept = empty();
  for (const p of paid) {
    if (p.refunded) add(refunded, p.amountCents, p.demo);
    else add(earned, p.amountCents, p.demo);
    if (p.revokedKept) add(revokedKept, p.amountCents, p.demo);
  }
  return { earned, refunded, revokedKept };
}

/** The newest grant and revocation receipt per version, in one query. */
async function receiptIds(db: Db, versionIds: string[]): Promise<Overview['receipts']> {
  if (versionIds.length === 0) return {};
  const rows = await db.query<{ version_id: string; kind: 'grant' | 'revocation'; public_id: string }>(
    `select distinct on (version_id, kind) version_id, kind, public_id
       from (select version_id, coalesce(body->>'kind', 'grant') as kind, public_id, seq from receipts where version_id = any($1::uuid[])) r
      order by version_id, kind, seq desc`, [versionIds]);
  const out: Overview['receipts'] = {};
  for (const r of rows) (out[r.version_id] ??= {})[r.kind] = r.public_id;
  return out;
}

/** review B7C-2 finding 2: what waits for the creator, each item once. */
export function waitingCounts(deals: Pick<DealRow, 'briefId' | 'status'>[], ask: Pick<AskItem, 'briefId' | 'hardBlock' | 'sendError'>[]): Overview['waiting'] {
  const blocked = ask.filter((a) => a.hardBlock);
  const failed = new Set([...deals.filter((d) => d.status === 'failed').map((d) => d.briefId), ...ask.filter((a) => !a.hardBlock && a.sendError).map((a) => a.briefId)]);
  return {
    approvals: ask.filter((a) => !a.hardBlock && !a.sendError).length,
    blocked: blocked.length,
    blockedBriefId: blocked[0]?.briefId ?? null,
    checks: deals.filter((d) => ['needs_creator', 'clarify', 'awaiting_transcript'].includes(d.status)).length,
    failed: failed.size,
  };
}

/** review B7C-2 finding 1: the Overview reads every deal, not the Deals page's newest 200. */
const ALL_DEALS = 1_000_000;

export async function getOverview(db: Db, creatorId: string): Promise<Overview> {
  const [deals, ask, alerts, ledger, paid, partial, seededRows] = await Promise.all([
    listDeals(db, creatorId, ALL_DEALS), listAsk(db, creatorId), listAlerts(db, creatorId), listLedger(db, creatorId), listPaidVersions(db, creatorId),
    db.query<{ n: number }>(`select count(*)::int as n from events where creator_id = $1 and kind = 'refund_partial'`, [creatorId]),
    // B12 E6: the demo seed writes its requests' extractions itself (raw_model.demo), so the agent did not catch them.
    db.query<{ id: string }>(`select distinct brief_id as id from extractions where creator_id = $1 and raw_model->>'demo' = 'true'`, [creatorId]),
  ]);
  const { earned, refunded, revokedKept } = moneyTotals(paid);
  const pending = empty();
  const unpaid = deals.filter((d) => d.status === 'invoiced');
  for (const d of unpaid) add(pending, d.gapTotalCents, d.demo);

  const seeded = new Set(seededRows.map((r) => r.id));
  const caught = deals.filter((d) => (d.gapTotalCents ?? 0) > 0);
  const isSeeded = (d: DealRow) => d.demo || seeded.has(d.briefId);
  return {
    totals: { earned, pending, refunded, revokedKept },
    headline: {
      caught: caught.filter((d) => !isSeeded(d)).length, caughtDemo: caught.filter(isSeeded).length,
      invoicedCents: earned.liveCents + pending.liveCents + refunded.liveCents, recoveredCents: earned.liveCents,
    },
    partlyRefunded: partial[0]?.n ?? 0,
    waiting: waitingCounts(deals, ask),
    alertsShown: alerts.length,
    unpaid,
    ask,
    alerts,
    recent: ledger.slice(0, 8),
    receipts: await receiptIds(db, paid.map((p) => p.versionId)),
  };
}
