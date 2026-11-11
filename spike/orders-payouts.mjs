// Step 9 (server half) + step 10: create an Orders v2 order, one sandbox Payout.
import { api } from './paypal.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const versionId = randomUUID();
const o = await api('POST', '/v2/checkout/orders', {
  intent: 'CAPTURE',
  purchase_units: [{ custom_id: versionId, description: 'UseRight spike licence v2', amount: { currency_code: 'USD', value: '420.00' } }],
  payment_source: { paypal: { experience_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel', user_action: 'PAY_NOW' } } },
}, { 'PayPal-Request-Id': versionId });
console.log('order', o.status, o.json.id, o.json.status);
console.log('approve link', o.json.links?.find(l => l.rel === 'payer-action')?.href);

const p = await api('POST', '/v1/payments/payouts', {
  sender_batch_header: { sender_batch_id: randomUUID(), email_subject: 'UseRight collaborator share' },
  items: [{ recipient_type: 'EMAIL', amount: { value: '10.00', currency: 'USD' }, receiver: 'collaborator@example.com', note: 'spike' }],
});
console.log('payout', p.status, p.json.batch_header?.batch_status ?? p.json.name, p.json.message ?? '');

const st = existsSync('state.json') ? JSON.parse(readFileSync('state.json')) : {};
writeFileSync('state.json', JSON.stringify({ ...st, orderId: o.json.id, orderCustomId: versionId, payoutBatch: p.json.batch_header?.payout_batch_id }, null, 2));
