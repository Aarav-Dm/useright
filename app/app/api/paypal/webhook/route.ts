import { handleWebhook } from '@/lib/webhooks';
import { grantDeps, json, readRawBody } from '@/lib/server';

export const runtime = 'nodejs';

const MAX_WEBHOOK_BYTES = 256 * 1024;

/**
 * PayPal webhooks (batch-6 §2, fixes 8, 23). Public: trust comes only from PayPal's verify-webhook-signature.
 * Review F10: the body is read up to MAX_WEBHOOK_BYTES and cancelled past it (413, no PayPal call); the accepted
 * bytes go to verification exactly as sent.
 */
export async function POST(req: Request) {
  let raw: string | null;
  try {
    raw = await readRawBody(req, MAX_WEBHOOK_BYTES);
  } catch {
    return json({ error: 'body is not valid UTF-8' }, 400);
  }
  if (raw === null) return json({ error: 'body too large' }, 413);
  const r = await handleWebhook(await grantDeps(), req.headers, raw);
  return json(r.body, r.status);
}
