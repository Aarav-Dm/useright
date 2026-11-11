import { api } from './paypal.mjs';
for (const id of process.argv.slice(2)) { const o = await api('GET', `/v2/checkout/orders/${id}`); console.log(id, o.json.status); }
