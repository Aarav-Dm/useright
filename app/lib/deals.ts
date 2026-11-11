// Deals list (batch-4 §2, §6 fix 1; batch-5 fix 8). One row per brief, newest first.
import type { Db } from '../db/client';
import { dealState, gapPreview, type BriefRow, type DealStatus, type PolicyResult, type StoredChecks } from './briefs';
import type { CheckResult } from './checks';
import { isDemoInvoiceId } from './demo';
import { hasPaidUse } from './reasons';

export type { DealStatus };

export type DealRow = {
  briefId: string;
  client: { id: string; name: string } | null; // null = unknown sender
  asset: { id: string; title: string } | null;
  source: BriefRow['source'];
  status: DealStatus;
  /** Why the deal is in this status; empty when ready or invoiced. */
  reasons: string[];
  /** Amount due in cents: the quoted version's total once one exists, else the gap preview; null = no price yet. */
  gapTotalCents: number | null;
  paypalInvoiceId: string | null;
  /** Batch 7: the deal's invoice is seeded demo data (`INV2-DEMO-`), never PayPal evidence. Display only. */
  demo: boolean;
  createdAt: Date;
};

type Joined = BriefRow & {
  client_name: string | null;
  asset_title: string | null;
  x_id: string | null;
  x_status: CheckResult['status'] | null;
  x_reasons: string[] | null;
  x_raw: StoredChecks | null;
  t_lines: number | null;
  v_status: string | null;
  v_send_state: 'idle' | 'sending' | 'sent' | 'failed' | null;
  v_policy: PolicyResult | null;
  v_extraction_id: string | null;
  v_rejected_at: Date | null;
  v_total: number | null;
  i_state: string | null;
  i_paypal: string | null;
};

export async function listDeals(db: Db, creatorId: string, limit = 200): Promise<DealRow[]> {
  const rows = await db.query<Joined>(
    `select b.*, c.name as client_name, a.title as asset_title,
            x.id as x_id, x.status as x_status, x.reasons as x_reasons, x.raw as x_raw, t.n as t_lines,
            v.status as v_status, v.send_state as v_send_state, v.policy as v_policy, v.extraction_id as v_extraction_id,
            v.rejected_at as v_rejected_at, v.total_cents as v_total, i.state as i_state, i.paypal_invoice_id as i_paypal
       from briefs b
       left join clients c on c.id = b.client_id
       left join assets a on a.id = b.asset_id
       left join lateral (
         select id, status, reasons, raw from extractions e where e.brief_id = b.id order by e.seq desc limit 1
       ) x on true
       left join lateral (
         select jsonb_array_length(lines)::int as n from transcripts tr where tr.brief_id = b.id order by tr.seq desc limit 1
       ) t on true
       left join lateral (
         select * from licence_versions lv where lv.brief_id = b.id order by lv.seq desc limit 1
       ) v on true
       left join lateral (
         select state, paypal_invoice_id from invoices iv where iv.version_id = v.id order by iv.seq desc limit 1
       ) i on true
      where b.creator_id = $1
      order by b.created_at desc, b.seq desc
      limit $2`,
    [creatorId, limit],
  );
  const out: DealRow[] = [];
  for (const r of rows) {
    const extraction = r.x_status ? { status: r.x_status, reasons: r.x_reasons ?? [] } : null;
    const version = r.v_status
      ? { status: r.v_status, sendState: r.v_send_state!, policy: r.v_policy, extractionId: r.v_extraction_id, rejectedAt: r.v_rejected_at, invoiceState: r.i_state }
      : null;
    const { status, reasons } = dealState(r.state, extraction, r.t_lines, { version, briefRejectedAt: r.rejected_at ?? null, latestExtractionId: r.x_id });
    const quoted = r.v_status === 'pending' ? r.v_total : null;
    const preview = quoted === null && r.state === 'extracted' && r.x_raw && !hasPaidUse(r.x_reasons) ? await gapPreview(db, r, r.x_raw.requested) : null;
    out.push({
      briefId: r.id,
      client: r.client_id && r.client_name ? { id: r.client_id, name: r.client_name } : null,
      asset: r.asset_id && r.asset_title ? { id: r.asset_id, title: r.asset_title } : null,
      source: r.source,
      status,
      reasons,
      gapTotalCents: quoted ?? (preview ? preview.totalCents : null),
      paypalInvoiceId: r.i_state && r.i_state !== 'cancelled' ? r.i_paypal : null,
      demo: isDemoInvoiceId(r.i_paypal),
      createdAt: r.created_at,
    });
  }
  return out;
}
