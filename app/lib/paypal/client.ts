// PayPal REST client, ported from spike/paypal.mjs (batch-5 §4, fixes 6, 20).
// Token cached until expires_in - 60 s. Errors and logs carry status, issue name and debug id only.
import { paypalCredentials, type PayPalCredentials } from './env';

export class PayPalError extends Error {
  constructor(readonly status: number, readonly issue: string | null, readonly debugId: string | null) {
    super(`PayPal ${status}${issue ? ` ${issue}` : ''}`);
    this.name = 'PayPalError';
  }
}
export class PayPalTimeout extends Error {
  constructor(readonly op: string) {
    super(`PayPal did not answer in time (${op})`);
    this.name = 'PayPalTimeout';
  }
}

export type ApiResult = { status: number; ok: boolean; json: Record<string, unknown>; debugId: string | null };

/** A JSON body sent byte for byte as given (batch-6 fix 23: the webhook event goes to PayPal as received). */
export class RawJson {
  constructor(readonly text: string) {}
}

export interface PayPalClient {
  api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResult>;
  credentials(): PayPalCredentials;
}

const SECRET_KEY = /authorization|access_token|client_secret|secret|password|token|api[-_]?key/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Deep copy with secrets and email addresses removed (fix 20). Use on anything before it is logged or stored. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(EMAIL, '[email]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/Basic\s+\S+/gi, 'Basic [redacted]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v)]));
  }
  return value;
}

/** First issue name PayPal reports, e.g. DUPLICATE_INVOICE_NUMBER (never the free-text message, which can echo data). */
export function issueOf(json: Record<string, unknown>): string | null {
  const details = json.details as { issue?: unknown }[] | undefined;
  const issue = Array.isArray(details) && typeof details[0]?.issue === 'string' ? details[0].issue : null;
  if (issue) return issue;
  return typeof json.name === 'string' ? json.name : typeof json.error === 'string' ? json.error : null;
}

export function logPayPalError(op: string, err: unknown): void {
  const info = err instanceof PayPalError ? { status: err.status, issue: err.issue, debugId: err.debugId }
    : err instanceof PayPalTimeout ? { timeout: true }
    : { error: err instanceof Error ? err.name : 'unknown' };
  console.warn('[paypal]', op, JSON.stringify(redact(info)));
}

export type ClientOptions = { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number };

export function createPayPalClient(opts: ClientOptions = {}): PayPalClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const now = opts.now ?? Date.now;
  let creds: PayPalCredentials | null = null;
  let cached: { token: string; until: number } | null = null;
  const credentials = () => (creds ??= paypalCredentials(opts.env));

  async function call(url: string, init: RequestInit, op: string): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new PayPalTimeout(op);
      throw err;
    }
  }

  async function token(): Promise<string> {
    if (cached && now() < cached.until) return cached.token;
    const c = credentials();
    const r = await call(`${c.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    }, 'token');
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!r.ok || !j.access_token) throw new PayPalError(r.status, j.error ?? 'TOKEN_FAILED', r.headers.get('paypal-debug-id'));
    cached = { token: j.access_token, until: now() + Math.max(0, (j.expires_in ?? 0) - 60) * 1000 };
    return cached.token;
  }

  return {
    credentials,
    async api(method, path, body, headers = {}) {
      const r = await call(credentials().base + path, {
        method,
        headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', prefer: 'return=representation', ...headers },
        body: body === undefined ? undefined : body instanceof RawJson ? body.text : JSON.stringify(body),
      }, `${method} ${path.replace(/INV2-[A-Z0-9-]+/g, ':id')}`);
      const text = await r.text();
      let json: Record<string, unknown>;
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        json = {};
      }
      return { status: r.status, ok: r.ok, json, debugId: r.headers.get('paypal-debug-id') };
    },
  };
}
