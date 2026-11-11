// Sandbox cleanup (batch-5 fix 10): cancel one invoice by id and print its final status. Usage via md-secret:
//   node .../md-secret.cjs run MY_CLIENT_ID -- node .../md-secret.cjs run MY_PAYPAL_SECRET -- npx tsx scripts/cancel-invoice.ts INV2-...
import { createPayPalClient } from '../lib/paypal/client';
import { createInvoiceApi } from '../lib/paypal/invoices';

const id = process.argv[2];
if (!id || !/^INV2-[A-Z0-9-]+$/.test(id)) throw new Error('usage: cancel-invoice.ts INV2-...');
const api = createInvoiceApi(createPayPalClient(), null);
const before = await api.get(id);
if (before.status !== 'CANCELLED') await api.cancel(id);
const after = await api.get(id);
console.log(`${id}: ${before.status} -> ${after.status}`);
