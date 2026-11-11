// Step 8: Agent Toolkit as a server-side library (never handed to a model). Can it set invoice_number?
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { randomUUID } from 'node:crypto';
const kit = new PayPalAgentToolkit({
  clientId: process.env.MY_CLIENT_ID ?? process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.MY_PAYPAL_SECRET,
  configuration: { actions: { invoices: { create: true, get: true } }, context: { sandbox: true } },
});
const tools = kit.getTools();
console.log('tools:', Object.keys(tools).join(', '));
const number = 'UR-' + randomUUID().replace(/-/g, '').slice(0, 22);
const out = await tools.create_invoice.execute({
  invoice_number: number, currency_code: 'USD', allow_tip: false, allow_partial_payment: false,
  primary_recipients: [{ billing_info: { email_address: 'northwind-buyer@example.com' } }],
  items: [{ name: 'Toolkit spike line', quantity: '1', unit_amount: { currency_code: 'USD', value: '1.00' } }],
}, {});
console.log('create_invoice ->', JSON.stringify(out).slice(0, 400));
