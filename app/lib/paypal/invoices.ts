// Invoicing v2 operations (batch-5 §4, fix 3). create() goes through the PayPal Agent Toolkit create_invoice
// as a server-side library (never a model tool), with a direct REST fallback on any toolkit error.
import { centsToValue } from '../money';
import { createPayPalClient, issueOf, logPayPalError, PayPalError, PayPalTimeout, type PayPalClient } from './client';

export type InvoiceDraft = {
  invoiceNumber: string; // UR- + 22 hex, max 25 chars
  recipientEmail: string;
  itemName: string;
  itemDescription: string;
  amountCents: number;
  note: string;
};

export type PayPalInvoice = {
  id: string;
  status: string;
  invoiceNumber: string | null;
  amountValue: string | null;
  currency: string | null;
  payerUrl: string | null;
  allowTip: boolean | null;
  allowPartial: boolean | null;
};

export interface InvoiceApi {
  /** Creates a draft; returns its PayPal id. Throws PayPalError (e.g. 422 DUPLICATE_INVOICE_NUMBER) or PayPalTimeout. */
  create(draft: InvoiceDraft): Promise<string>;
  send(id: string): Promise<void>;
  get(id: string): Promise<PayPalInvoice>;
  findByNumber(invoiceNumber: string): Promise<PayPalInvoice | null>;
  cancel(id: string): Promise<void>;
  /** Deletes a draft (used when send fails after create). */
  remove(id: string): Promise<void>;
}

/** Invoice body exactly as the spike sent it: one line item, no tip, no partial payment, no tax/discount/shipping. */
export function invoiceBody(d: InvoiceDraft) {
  return {
    detail: { invoice_number: d.invoiceNumber, currency_code: 'USD', note: d.note },
    primary_recipients: [{ billing_info: { email_address: d.recipientEmail } }],
    items: [{ name: d.itemName, description: d.itemDescription, quantity: '1', unit_amount: { currency_code: 'USD', value: centsToValue(d.amountCents) } }],
    configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
  };
}

/** Same invoice in the toolkit's flat create_invoice schema (spike/toolkit.mjs). */
export function toolkitArgs(d: InvoiceDraft) {
  const b = invoiceBody(d);
  return {
    invoice_number: d.invoiceNumber, currency_code: 'USD', note: d.note, allow_tip: false, allow_partial_payment: false,
    primary_recipients: b.primary_recipients, items: b.items,
  };
}

/** PayPal id from a create response: `id`, or the last segment of the self link (create without Prefer). */
export function invoiceIdFrom(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as { id?: unknown; href?: unknown; links?: { href?: unknown }[] };
  if (typeof o.id === 'string' && /^INV2-[A-Z0-9-]+$/.test(o.id)) return o.id;
  for (const href of [o.href, ...(o.links ?? []).map((l) => l.href)]) {
    const m = typeof href === 'string' ? /\/v2\/invoicing\/invoices\/(INV2-[A-Z0-9-]+)/.exec(href) : null;
    if (m) return m[1]!;
  }
  return null;
}

function toInvoice(j: Record<string, unknown>): PayPalInvoice {
  const detail = (j.detail ?? {}) as { invoice_number?: string; metadata?: { recipient_view_url?: string } };
  const amount = (j.amount ?? {}) as { value?: string; currency_code?: string };
  const config = (j.configuration ?? {}) as { allow_tip?: boolean; partial_payment?: { allow_partial_payment?: boolean } };
  return {
    id: String(j.id ?? ''),
    status: String(j.status ?? ''),
    invoiceNumber: detail.invoice_number ?? null,
    amountValue: amount.value ?? null,
    currency: amount.currency_code ?? null,
    payerUrl: detail.metadata?.recipient_view_url ?? null,
    allowTip: config.allow_tip ?? null,
    allowPartial: config.partial_payment?.allow_partial_payment ?? null,
  };
}

const fail = (r: { status: number; json: Record<string, unknown>; debugId: string | null }) => new PayPalError(r.status, issueOf(r.json), r.debugId);

export function restInvoiceApi(client: PayPalClient): InvoiceApi {
  return {
    async create(d) {
      const r = await client.api('POST', '/v2/invoicing/invoices', invoiceBody(d));
      const id = r.ok ? invoiceIdFrom(r.json) : null;
      if (!id) throw fail(r);
      return id;
    },
    async send(id) {
      const r = await client.api('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: false, send_to_recipient: true });
      if (!r.ok) throw fail(r);
    },
    async get(id) {
      const r = await client.api('GET', `/v2/invoicing/invoices/${id}`);
      if (!r.ok) throw fail(r);
      return toInvoice(r.json);
    },
    async findByNumber(invoiceNumber) {
      const r = await client.api('POST', '/v2/invoicing/search-invoices?page=1&page_size=5', { invoice_number: invoiceNumber });
      if (!r.ok) throw fail(r);
      const items = (r.json.items ?? []) as Record<string, unknown>[];
      const hit = items.find((i) => (i.detail as { invoice_number?: string } | undefined)?.invoice_number === invoiceNumber);
      return hit ? this.get(String(hit.id)) : null;
    },
    async cancel(id) {
      const r = await client.api('POST', `/v2/invoicing/invoices/${id}/cancel`, { send_to_invoicer: false, send_to_recipient: true, note: 'This invoice was replaced by an updated quote.' });
      if (!r.ok && r.status !== 204) throw fail(r);
    },
    async remove(id) {
      const r = await client.api('DELETE', `/v2/invoicing/invoices/${id}`);
      if (!r.ok && r.status !== 204) throw fail(r);
    },
  };
}

export type ToolkitCreate = (args: ReturnType<typeof toolkitArgs>) => Promise<string>;

type ToolkitInternals = { client?: { _baseUrl?: string; getBaseUrl?: () => string }; _paypal?: { baseUrl?: string } };

/**
 * B5 review 2: the toolkit derives its host from the sandbox boolean (api.sandbox.paypal.com /
 * api.paypal.com), while REST uses credentials().base. Point both of the toolkit's clients (token + create) at
 * credentials().base; if the toolkit's shape ever changes, refuse (create then falls back to REST on base).
 */
export function pinToolkitHost(kit: unknown, base: string): void {
  const k = kit as ToolkitInternals;
  if (!k.client || typeof k.client._baseUrl !== 'string' || !k._paypal || typeof k._paypal.baseUrl !== 'string') {
    throw new Error('agent toolkit layout changed; cannot pin its PayPal host');
  }
  k.client._baseUrl = base;
  k._paypal.baseUrl = base;
  if (k.client.getBaseUrl?.() !== base) throw new Error('agent toolkit host pin did not take');
}

/** create_invoice from @paypal/agent-toolkit/ai-sdk, loaded on first use with the same credentials. */
export function agentToolkitCreate(client: PayPalClient): ToolkitCreate {
  let tool: Promise<{ execute: (args: unknown, opts: unknown) => Promise<unknown> }> | null = null;
  return async (args) => {
    tool ??= (async () => {
      const { PayPalAgentToolkit } = await import('@paypal/agent-toolkit/ai-sdk');
      const c = client.credentials();
      const kit = new PayPalAgentToolkit({
        clientId: c.clientId, clientSecret: c.clientSecret,
        configuration: { actions: { invoices: { create: true } }, context: { sandbox: c.sandbox } },
      });
      pinToolkitHost(kit, c.base);
      return (kit.getTools() as unknown as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>).create_invoice!;
    })();
    const exec = (await tool).execute(args, {});
    // B5 review 4: the toolkit has no timeout of its own. On timeout the REST fallback runs; if the toolkit
    // did create the invoice, REST gets 422 DUPLICATE_INVOICE_NUMBER and the caller reuses it by number.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const out = await Promise.race([
      exec,
      new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new PayPalTimeout('toolkit create_invoice')), TOOLKIT_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    return typeof out === 'string' ? out : JSON.stringify(out);
  };
}

export const TOOLKIT_TIMEOUT_MS = 20_000;

/** Toolkit first; any toolkit error or unparsable result -> the REST call (which reports duplicates as 422). */
export function createInvoiceApi(client: PayPalClient, toolkit: ToolkitCreate | null = agentToolkitCreate(client)): InvoiceApi {
  const rest = restInvoiceApi(client);
  return {
    ...rest,
    async create(d) {
      if (toolkit) {
        try {
          const id = invoiceIdFrom(JSON.parse(await toolkit(toolkitArgs(d))));
          if (id) return id;
        } catch (err) {
          logPayPalError('toolkit create_invoice', err);
        }
      }
      return rest.create(d);
    },
  };
}

let defaultApi: InvoiceApi | null = null;
/** Process-wide API from env. Credentials are read at the first call, not here. */
export function invoiceApiFromEnv(): InvoiceApi {
  return (defaultApi ??= createInvoiceApi(createPayPalClient()));
}

export { PayPalError, PayPalTimeout };
