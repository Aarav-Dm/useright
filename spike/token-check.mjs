import { token, api } from './paypal.mjs';
await token(); console.log('token: ok');
const u = await api('GET', '/v1/identity/oauth2/userinfo?schema=paypalv1.1');
console.log('merchant userinfo:', u.status, u.json.emails?.[0]?.value ?? '', u.json.payer_id ?? '');
