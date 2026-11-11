// PayPal credentials (batch-5 §4, fix 6). Read lazily at the first call, never at import, so `next build`
// passes without them. Saved secrets are MY_CLIENT_ID / MY_PAYPAL_SECRET; the PAYPAL_* names win when set.

export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

export class PayPalConfigError extends Error {
  constructor() {
    super('PayPal is not configured (PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET or MY_CLIENT_ID/MY_PAYPAL_SECRET)');
    this.name = 'PayPalConfigError';
  }
}

export type PayPalCredentials = { clientId: string; clientSecret: string; base: string; sandbox: boolean };

export function paypalCredentials(env: NodeJS.ProcessEnv = process.env): PayPalCredentials {
  const clientId = env.PAYPAL_CLIENT_ID ?? env.MY_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET ?? env.MY_PAYPAL_SECRET;
  if (!clientId || !clientSecret) throw new PayPalConfigError();
  // B5 review 7: only PayPal's two API hosts; the live one needs an explicit PAYPAL_ENV=live.
  let host: string;
  try {
    const u = new URL(env.PAYPAL_BASE ?? SANDBOX_BASE);
    if (u.protocol !== 'https:' || (u.pathname !== '/' && u.pathname !== '')) throw new Error('bad');
    host = u.host;
  } catch {
    throw new PayPalHostError();
  }
  if (host !== SANDBOX_HOST && host !== LIVE_HOST) throw new PayPalHostError();
  if (host === LIVE_HOST && env.PAYPAL_ENV !== 'live') throw new PayPalHostError();
  return { clientId, clientSecret, base: `https://${host}`, sandbox: host === SANDBOX_HOST };
}

export const SANDBOX_HOST = 'api-m.sandbox.paypal.com';
export const LIVE_HOST = 'api-m.paypal.com';

export class PayPalHostError extends Error {
  constructor() {
    super(`PAYPAL_BASE must be https://${SANDBOX_HOST} (or https://${LIVE_HOST} with PAYPAL_ENV=live)`);
    this.name = 'PayPalHostError';
  }
}
