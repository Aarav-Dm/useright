// Steps 5-6: read back the invoice, run the invoice grantIfPaid predicate, test whether the transaction id is a capture id.
import { api } from './paypal.mjs';
import { readFileSync } from 'node:fs';
const { invoiceId, invoiceNumber, amount } = JSON.parse(readFileSync('state.json'));
const g = await api('GET', `/v2/invoicing/invoices/${invoiceId}`);
const inv = g.json, txs = inv.payments?.transactions ?? [];
const paid = inv.payments?.paid_amount;
const grant = inv.status === 'PAID' && paid?.value === amount && paid?.currency_code === 'USD' && inv.detail.invoice_number === invoiceNumber
  && txs.length > 0 && txs.every(t => t.method === 'PAYPAL');
console.log({ status: inv.status, paid, invoice_number_match: inv.detail.invoice_number === invoiceNumber, transactions: txs.map(t => ({ id: t.payment_id, method: t.method, type: t.type, amount: t.amount })), grantIfPaid: grant });
for (const t of txs) { const c = await api('GET', `/v2/payments/captures/${t.payment_id}`); console.log('capture lookup', t.payment_id, c.status, c.json.status ?? c.json.name); }
