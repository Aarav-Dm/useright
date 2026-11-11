// Step 9: capture an approved order, read it back, run the Orders grantIfPaid predicate. Usage: node capture.mjs <orderId> <expectedCustomId>
import { api } from './paypal.mjs';
const [orderId, customId] = process.argv.slice(2);
const c = await api('POST', `/v2/checkout/orders/${orderId}/capture`, {}, { 'PayPal-Request-Id': `cap-${orderId}` });
console.log('capture', c.status, c.json.status ?? c.json.name, c.json.details?.[0]?.issue ?? '');
const o = await api('GET', `/v2/checkout/orders/${orderId}`);
const pu = o.json.purchase_units?.[0], cap = pu?.payments?.captures?.[0];
const grant = o.json.status === 'COMPLETED' && cap?.status === 'COMPLETED' && cap.amount.value === '420.00' && cap.amount.currency_code === 'USD' && pu.custom_id === customId;
console.log({ order: o.json.status, capture: cap?.status, captureId: cap?.id, amount: cap?.amount, custom_id_match: pu?.custom_id === customId, funding: Object.keys(o.json.payment_source ?? {}), grantIfPaid: grant });
