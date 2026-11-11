// PayPal reads for payment and refund checks (batch-6 §1, §2, §4, fixes 5, 6, 8, 21, 23).
// Webhook bodies are hints only: everything that unlocks or revokes is re-fetched here.
import { createPayPalClient, issueOf, PayPalError, RawJson, type PayPalClient } from './client';

export type InvoiceJson = Record<string, unknown>;
export type Capture = { id: string; status: string };
export type WebhookHeaders = { authAlgo: string; certUrl: string; transmissionId: string; transmissionSig: string; transmissionTime: string };

export interface PaymentsApi {
  /** Full invoice JSON by PayPal invoice id. Throws PayPalError / PayPalTimeout. */
  getInvoice(id: string): Promise<InvoiceJson>;
  /** Capture by id (an invoice payment's `payment_id` is a capture id, spike row 6). */
  getCapture(id: string): Promise<Capture>;
  /**
   * verify-webhook-signature over the raw body. Returns PayPal's verification_status. Throws PayPalError
   * (with its HTTP status) or PayPalTimeout when PayPal cannot answer.
   */
  verifyWebhook(headers: WebhookHeaders, rawBody: string, webhookId: string): Promise<string>;
}

export class WebhookConfigError extends Error {
  constructor() {
    super('PAYPAL_WEBHOOK_ID is not set');
    this.name = 'WebhookConfigError';
  }
}

/** Read lazily at the first webhook (like the PayPal keys), never at import. */
export function webhookId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env.PAYPAL_WEBHOOK_ID;
  if (!id || !/^[A-Z0-9-]{5,64}$/.test(id)) throw new WebhookConfigError();
  return id;
}

const fail = (r: { status: number; json: Record<string, unknown>; debugId: string | null }) => new PayPalError(r.status, issueOf(r.json), r.debugId);
const ID_RE = /^[A-Z0-9-]{5,64}$/;

export function restPaymentsApi(client: PayPalClient): PaymentsApi {
  return {
    async getInvoice(id) {
      if (!ID_RE.test(id)) throw new PayPalError(400, 'BAD_ID', null);
      const r = await client.api('GET', `/v2/invoicing/invoices/${id}`);
      if (!r.ok) throw fail(r);
      return r.json;
    },
    async getCapture(id) {
      if (!ID_RE.test(id)) throw new PayPalError(400, 'BAD_ID', null);
      const r = await client.api('GET', `/v2/payments/captures/${id}`);
      if (!r.ok) throw fail(r);
      return { id: String(r.json.id ?? id), status: String(r.json.status ?? '') };
    },
    async verifyWebhook(h, rawBody, hookId) {
      // Fix 23: the event is embedded exactly as PayPal sent it; no parse/re-serialise round trip.
      const head = JSON.stringify({
        auth_algo: h.authAlgo, cert_url: h.certUrl, transmission_id: h.transmissionId,
        transmission_sig: h.transmissionSig, transmission_time: h.transmissionTime, webhook_id: hookId,
      });
      const body = `${head.slice(0, -1)},"webhook_event":${rawBody}}`;
      const r = await client.api('POST', '/v1/notifications/verify-webhook-signature', new RawJson(body));
      if (!r.ok) throw fail(r);
      return String(r.json.verification_status ?? '');
    },
  };
}

let defaultApi: PaymentsApi | null = null;
export function paymentsApiFromEnv(): PaymentsApi {
  return (defaultApi ??= restPaymentsApi(createPayPalClient()));
}
