// Steps 1-2, 6-7: create + send an invoice, check duplicate protection. Usage: node invoice.mjs [amount]
import { api } from './paypal.mjs';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const amount = process.argv[2] ?? '420.00';
const number = 'UR-' + randomUUID().replace(/-/g, '').slice(0, 22); // invoice_number max 25 chars
const body = {
  detail: { invoice_number: number, currency_code: 'USD', note: 'UseRight spike: print licence gap' },
  primary_recipients: [{ billing_info: { email_address: 'northwind-buyer@example.com' } }],
  items: [{ name: 'Print, US, 12 months (licence gap)', quantity: '1', unit_amount: { currency_code: 'USD', value: amount } }],
  configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
};
const reqId = randomUUID();
const c1 = await api('POST', '/v2/invoicing/invoices', body, { 'PayPal-Request-Id': reqId });
console.log('create', c1.status, c1.json.id ?? JSON.stringify(c1.json).slice(0, 300));
const c2 = await api('POST', '/v2/invoicing/invoices', body, { 'PayPal-Request-Id': reqId });
console.log('same request id again', c2.status, c2.json.id ?? c2.json.name, '| same invoice:', !!c1.json.id && c2.json.id === c1.json.id);
const c3 = await api('POST', '/v2/invoicing/invoices', body);
console.log('same invoice_number, new request', c3.status, c3.json.name ?? c3.json.id, c3.json.details?.[0]?.issue ?? '');

const id = c1.json.id;
const s = await api('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: false, send_to_recipient: true });
console.log('send', s.status, JSON.stringify(s.json).slice(0, 200));
const g = await api('GET', `/v2/invoicing/invoices/${id}`);
console.log('status', g.json.status, 'allow_partial', g.json.configuration?.partial_payment?.allow_partial_payment, 'tip', g.json.configuration?.allow_tip);
console.log('payer link', g.json.detail?.metadata?.recipient_view_url);
writeFileSync('state.json', JSON.stringify({ invoiceId: id, invoiceNumber: number, amount }, null, 2));
