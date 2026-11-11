// PayPal reuses a cached access token (with its old scopes) until expiry; terminate it so a new one picks up new app features.
import { BASE, token } from './paypal.mjs';
const t = await token();
const auth = 'Basic ' + Buffer.from(`${(process.env.MY_CLIENT_ID ?? process.env.PAYPAL_CLIENT_ID)}:${process.env.MY_PAYPAL_SECRET}`).toString('base64');
const r = await fetch(`${BASE}/v1/oauth2/token/terminate`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${t}&token_type_hint=ACCESS_TOKEN` });
console.log('terminate', r.status, (await r.text()).slice(0, 150));
