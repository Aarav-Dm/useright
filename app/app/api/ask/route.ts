import { z } from 'zod';
import { listAlerts, listAsk } from '@/lib/ledger';
import { approve, reject } from '@/lib/send';
import { creatorId, deps, guard, invoices, json, readJson } from '@/lib/server';
import { loadVersion } from '@/lib/versions';

export const runtime = 'nodejs';

/** "Ask me" queue (batch-5 §3): pending quotes that failed a rule or whose send failed. */
export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const { db } = await deps();
  const me = await creatorId(db);
  if (me instanceof Response) return me;
  return json({ items: await listAsk(db, me), alerts: await listAlerts(db, me) });
}

const AskSchema = z.object({ versionId: z.string().uuid(), action: z.enum(['approve', 'reject']), typedTotal: z.string().max(20).optional() }).strict();

export async function POST(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const parsed = AskSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'body must be {versionId, action: "approve"|"reject", typedTotal?}' }, 400);
  const { db } = await deps();
  const me = await creatorId(db);
  if (me instanceof Response) return me;
  const v = await loadVersion(db, parsed.data.versionId);
  if (!v || v.creator_id !== me) return json({ error: 'quote not found' }, 404);
  if (parsed.data.action === 'reject') {
    // B5 review 10: reject the card's own version; a superseded card gets 409 and the page refreshes.
    const r = await reject(db, me, v.brief_id, v.id);
    return r.ok ? json({ ok: true }) : json({ error: r.error, code: r.code }, r.status);
  }
  const r = await approve(db, invoices(), me, { versionId: v.id }, parsed.data.typedTotal ?? '');
  return r.ok
    ? json({ ok: true, briefId: v.brief_id, invoiceNumber: r.send.invoiceNumber, paypalInvoiceId: r.send.paypalInvoiceId, payerUrl: r.send.payerUrl })
    : json({ error: r.error, code: r.code }, r.status);
}
