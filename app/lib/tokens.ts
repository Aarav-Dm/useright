// Public tokens (batch-6 fixes 9, 22): 32 random bytes, base64url; stored as sha256 hex. The pay link token is also
// kept encrypted (AES-256-GCM, key from APP_SECRET) so the deal room can show the same link again.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { sha256Hex } from './hash';
import { TOKEN_RE } from './verify-page';

export { TOKEN_RE };
export const newToken = () => randomBytes(32).toString('base64url');
/** Same sha256-hex format as before (F19: the shared helper). */
export const hashToken = (token: string) => sha256Hex(token);

export class AppSecretError extends Error {
  constructor() {
    super('APP_SECRET is not set');
    this.name = 'AppSecretError';
  }
}

/**
 * Key from APP_SECRET, read at call time (never at import, so `next build` needs no secret). Batch-6 review F11:
 * there is no built-in fallback key in any environment; tests set an explicit test secret (vitest.config.ts).
 */
function key(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret = env.APP_SECRET;
  if (!secret) throw new AppSecretError();
  return createHash('sha256').update(`useright:${secret}`).digest();
}

/** True when bearer links can be minted and read back on this server. Never reveals the value. */
export const hasAppSecret = (env: NodeJS.ProcessEnv = process.env) => !!env.APP_SECRET;

export function encryptToken(token: string, env?: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(env), iv);
  const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

/** null when the value was not made with this key (or was tampered with). */
export function decryptToken(enc: string, env?: NodeJS.ProcessEnv): string | null {
  try {
    const [iv, tag, body] = enc.split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key(env), iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(body!), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Absolute base for links that leave the app (PayPal invoice note). */
export function publicBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_BASE_URL ?? env.APP_ORIGIN ?? 'http://localhost:3000';
  try {
    return new URL(raw).origin;
  } catch {
    return 'http://localhost:3000';
  }
}

export const payPath = (token: string) => `/pay/${token}`;

/** "buying@northwind.example" -> "b*****@northwind.example". */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}${'*'.repeat(Math.max(3, at - 1))}${email.slice(at)}`;
}

/** The deal room's client link from the stored ciphertext (fix 9), or null. */
export function payLinkFromEnc(enc: string | null): string | null {
  const t = enc ? decryptToken(enc) : null;
  return t ? payPath(t) : null;
}
