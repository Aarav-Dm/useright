// PayPal client, invoice API and money parsing, with fetch mocked (no network).
import { describe, expect, it } from 'vitest';
import { centsToValue, parseCents } from '../lib/money';
import { createPayPalClient, PayPalError, redact } from '../lib/paypal/client';
import { createInvoiceApi, invoiceBody, invoiceIdFrom, type InvoiceDraft } from '../lib/paypal/invoices';
import { paypalCredentials, PayPalConfigError } from '../lib/paypal/env';

const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
const draft: InvoiceDraft = { invoiceNumber: 'UR-0123456789abcdef012345', recipientEmail: 'buyer@cafe.example', itemName: 'Image licence', itemDescription: 'v2', amountCents: 42000, note: 'n' };

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: { 'paypal-debug-id': 'dbg-1' } });
  }) as typeof fetch;
  return { f, calls };
}

describe('money (fix 20)', () => {
  it.each([['900', 90000], ['900.00', 90000], ['900.5', 90050], ['0.01', 1], [' 420.00 ', 42000], ['0007', 700]])('%s -> %i cents', (s, c) => {
    expect(parseCents(s)).toBe(c);
  });
  it.each(['$900', '900,00', '1,000', '-5', '9.999', '1e3', '', '.5', '900.', 'abc', '99999999'])('rejects %s', (s) => {
    expect(parseCents(s)).toBeNull();
  });
  it('formats cents exactly', () => {
    expect([centsToValue(42000), centsToValue(5), centsToValue(100050)]).toEqual(['420.00', '0.05', '1000.50']);
  });
});

describe('secrets and logging (fixes 6, 20)', () => {
  it('credentials prefer PAYPAL_* and fall back to MY_*; nothing is read until the first call', async () => {
    expect(paypalCredentials(env({ MY_CLIENT_ID: 'a', MY_PAYPAL_SECRET: 'b' }))).toMatchObject({ clientId: 'a', clientSecret: 'b', sandbox: true });
    expect(paypalCredentials(env({ PAYPAL_CLIENT_ID: 'p', MY_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'q', MY_PAYPAL_SECRET: 'b' }))).toMatchObject({ clientId: 'p', clientSecret: 'q' });
    const client = createPayPalClient({ env: env({}) }); // building it must not throw (next build has no secrets)
    await expect(client.api('GET', '/v2/invoicing/invoices/x')).rejects.toBeInstanceOf(PayPalConfigError);
  });
  it('redact strips tokens, secrets and emails', () => {
    const out = JSON.stringify(redact({ authorization: 'Bearer abc', access_token: 'xyz', client_secret: 's', note: 'from buyer@cafe.example', nested: [{ header: 'Basic Zm9vOmJhcg==' }] }));
    expect(out).not.toMatch(/abc|xyz|"s"|buyer@cafe|Zm9vOmJhcg/);
  });
});

describe('PayPal client', () => {
  it('caches the token until expires_in - 60 s', async () => {
    let t = 0;
    const { f, calls } = fakeFetch((url) => (url.endsWith('/v1/oauth2/token') ? { status: 200, body: { access_token: `tok${calls.length}`, expires_in: 120 } } : { status: 200, body: { id: 'x' } }));
    const c = createPayPalClient({ env: env({ MY_CLIENT_ID: 'a', MY_PAYPAL_SECRET: 'b' }), fetchImpl: f, now: () => t });
    await c.api('GET', '/a');
    await c.api('GET', '/b');
    t = 59_000;
    await c.api('GET', '/c');
    expect(calls.filter((x) => x.url.endsWith('/token'))).toHaveLength(1);
    t = 61_000;
    await c.api('GET', '/d');
    expect(calls.filter((x) => x.url.endsWith('/token'))).toHaveLength(2);
    expect(calls.find((x) => x.url.endsWith('/a'))!.url).toBe('https://api-m.sandbox.paypal.com/a');
  });
});

describe('invoice API', () => {
  const tokenOk = { status: 200, body: { access_token: 't', expires_in: 3600 } };
  it('the REST body matches the spike: one line, no tip, no partial payment, USD', () => {
    expect(invoiceBody(draft)).toEqual({
      detail: { invoice_number: draft.invoiceNumber, currency_code: 'USD', note: 'n' },
      primary_recipients: [{ billing_info: { email_address: 'buyer@cafe.example' } }],
      items: [{ name: 'Image licence', description: 'v2', quantity: '1', unit_amount: { currency_code: 'USD', value: '420.00' } }],
      configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
    });
  });
  it('parses the PayPal id from id, href or links', () => {
    expect(invoiceIdFrom({ id: 'INV2-AAAA-BBBB' })).toBe('INV2-AAAA-BBBB');
    expect(invoiceIdFrom({ rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-CCCC-DDDD', method: 'GET' })).toBe('INV2-CCCC-DDDD');
    expect(invoiceIdFrom({ links: [{ href: 'https://x/v2/invoicing/invoices/INV2-EEEE' }] })).toBe('INV2-EEEE');
    expect(invoiceIdFrom({ ok: false, code: 'PAYPAL_API_HTTP_ERROR' })).toBeNull();
  });
  it('uses the toolkit result when it carries an id', async () => {
    const { f, calls } = fakeFetch(() => tokenOk);
    const api = createInvoiceApi(createPayPalClient({ env: env({ MY_CLIENT_ID: 'a', MY_PAYPAL_SECRET: 'b' }), fetchImpl: f }), async (args) => {
      expect(args).toMatchObject({ invoice_number: draft.invoiceNumber, allow_tip: false, allow_partial_payment: false });
      return JSON.stringify({ rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-TOOL-0001', method: 'GET' });
    });
    expect(await api.create(draft)).toBe('INV2-TOOL-0001');
    expect(calls.filter((c) => c.url.includes('/v2/invoicing'))).toHaveLength(0);
  });
  it('any toolkit error -> REST fallback; a REST 422 surfaces as DUPLICATE_INVOICE_NUMBER', async () => {
    let restCreates = 0;
    const { f } = fakeFetch((url, init) => {
      if (url.endsWith('/token')) return tokenOk;
      if (url.endsWith('/v2/invoicing/invoices') && init.method === 'POST') {
        restCreates++;
        return restCreates === 1 ? { status: 201, body: { id: 'INV2-REST-0001' } } : { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'DUPLICATE_INVOICE_NUMBER' }] } };
      }
      return { status: 404 };
    });
    const client = createPayPalClient({ env: env({ MY_CLIENT_ID: 'a', MY_PAYPAL_SECRET: 'b' }), fetchImpl: f });
    const toolkitDown = createInvoiceApi(client, async () => JSON.stringify({ ok: false, code: 'PAYPAL_API_HTTP_ERROR', status: 500 }));
    expect(await toolkitDown.create(draft)).toBe('INV2-REST-0001');
    const toolkitThrows = createInvoiceApi(client, async () => { throw new Error('boom'); });
    const err = await toolkitThrows.create(draft).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 422, issue: 'DUPLICATE_INVOICE_NUMBER', debugId: 'dbg-1' });
  });
  it('findByNumber searches by invoice_number and reads the payer link', async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.endsWith('/token')) return tokenOk;
      if (url.includes('search-invoices')) return { status: 200, body: { items: [{ id: 'INV2-S-1', detail: { invoice_number: draft.invoiceNumber } }] } };
      return { status: 200, body: { id: 'INV2-S-1', status: 'SENT', detail: { invoice_number: draft.invoiceNumber, metadata: { recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#INV2-S-1' } }, amount: { value: '420.00', currency_code: 'USD' } } };
    });
    const api = createInvoiceApi(createPayPalClient({ env: env({ MY_CLIENT_ID: 'a', MY_PAYPAL_SECRET: 'b' }), fetchImpl: f }), null);
    expect(await api.findByNumber(draft.invoiceNumber)).toMatchObject({ id: 'INV2-S-1', status: 'SENT', payerUrl: expect.stringContaining('INV2-S-1'), amountValue: '420.00' });
    expect(JSON.parse(String(calls.find((c) => c.url.includes('search-invoices'))!.init.body))).toEqual({ invoice_number: draft.invoiceNumber });
  });
});
