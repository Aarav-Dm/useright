// Creator session (batch-3 §7 fix 8, batch-4 §6 fix 5): one CREATOR_TOKEN env, sent as the httpOnly
// `ur_creator` cookie (set by POST /api/login) or a bearer header (scripts). Real login is post-hackathon.
// CSRF (spec A6): every mutation must come from our own origin: Origin (or Referer) host == Host.
import { timingSafeEqual } from 'node:crypto';

export const CREATOR_COOKIE = 'ur_creator';
export const SESSION_MAX_AGE_S = 60 * 60 * 12;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(v.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function tokenMatches(token: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.CREATOR_TOKEN;
  return !!expected && !!token && safeEqual(token, expected);
}

export function isCreator(headers: Headers, env: NodeJS.ProcessEnv = process.env): boolean {
  const auth = headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  return tokenMatches(bearer, env) || tokenMatches(readCookie(headers.get('cookie'), CREATOR_COOKIE), env);
}

/** The creator a CREATOR_TOKEN session acts for. Single-creator app for now. */
export function sessionCreatorSlug(env: NodeJS.ProcessEnv = process.env): string {
  return env.CREATOR_SLUG ?? 'imani';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when a state-changing request comes from this site. Safe methods always pass.
 * review P5: a mutation must carry Origin (a missing or "null" Origin is refused; Referer is not trusted).
 * With APP_ORIGIN set (production) Origin must equal it exactly; only without it (dev) is Host compared.
 */
export function sameOrigin(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const origin = req.headers.get('origin');
  if (!origin || origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (env.APP_ORIGIN) {
    try {
      return parsed.origin === new URL(env.APP_ORIGIN).origin;
    } catch {
      return false; // misconfigured APP_ORIGIN fails closed
    }
  }
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  return !!host && parsed.host === host;
}

export type AuthFailure = { status: 401 | 403; error: string };

/**
 * Gate for creator routes. Mutations need the same origin even with a valid session, so another
 * site cannot ride the cookie. Bearer-only scripts must send an Origin header too.
 */
export function requireCreator(req: Request, env: NodeJS.ProcessEnv = process.env): { ok: true; slug: string } | ({ ok: false } & AuthFailure) {
  if (!isCreator(req.headers, env)) return { ok: false, status: 401, error: 'creator session required' };
  if (!sameOrigin(req, env)) return { ok: false, status: 403, error: 'cross-origin request refused' };
  return { ok: true, slug: sessionCreatorSlug(env) };
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${CREATOR_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_MAX_AGE_S}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

export const clearSessionCookie = `${CREATOR_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;


const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * Requester address for the per-IP cap (review P4): first hop of X-Forwarded-For, else X-Real-IP, else
 * "unknown". Next route handlers do not expose the socket address, so behind no proxy every request shares
 * the "unknown" bucket (fails closed). Anything that is not an IP literal also counts as "unknown".
 */
export function clientIp(headers: Headers): string {
  const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (first && IP_RE.test(first)) return first;
  const real = headers.get('x-real-ip')?.trim();
  if (real && IP_RE.test(real)) return real;
  return 'unknown';
}
