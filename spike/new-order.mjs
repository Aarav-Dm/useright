import { api } from './paypal.mjs';
import { randomUUID } from 'node:crypto';
const v = randomUUID();
const o = await api('POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ custom_id: v, amount: { currency_code: 'USD', value: '420.00' } }],
  payment_source: { paypal: { experience_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel', user_action: 'PAY_NOW' } } } }, { 'PayPal-Request-Id': v });
console.log(o.json.id, v, o.json.links?.find(l => l.rel === 'payer-action')?.href);
