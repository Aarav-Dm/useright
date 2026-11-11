import { BASE } from './paypal.mjs';
const r = await fetch(`${BASE}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${(process.env.MY_CLIENT_ID ?? process.env.PAYPAL_CLIENT_ID)}:${process.env.MY_PAYPAL_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
const j = await r.json();
const s = j.scope.split(' ').map(x => x.replace('https://uri.paypal.com/services/', ''));
console.log('app_id', j.app_id, '\n' + s.join('\n'));
