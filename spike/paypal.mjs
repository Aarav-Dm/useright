// Sandbox-only PayPal helpers for the day-1 spike. Secrets come from env, never printed.
export const BASE = 'https://api-m.sandbox.paypal.com';
const ID = process.env.MY_CLIENT_ID ?? process.env.PAYPAL_CLIENT_ID, SECRET = process.env.MY_PAYPAL_SECRET;
if (!ID || !SECRET) throw new Error('MY_CLIENT_ID / MY_PAYPAL_SECRET missing');

let tok;
export async function token() {
  if (tok) return tok;
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token ${r.status} ${j.error}: ${j.error_description}`);
  return (tok = j.access_token);
}

export async function api(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, ok: r.ok, json, debugId: r.headers.get('paypal-debug-id') };
}
