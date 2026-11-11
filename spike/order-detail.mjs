import { api } from './paypal.mjs';
const o = await api('GET', `/v2/checkout/orders/${process.argv[2]}`);
console.log(JSON.stringify(o.json.payment_source), o.json.payer?.email_address);
