// Process-wide dependencies for route handlers. Migrates once on first use.
import { openDb, type Db } from '../db/client';
import { migrate } from '../db/migrate';
import { adapterFromEnv } from './ai/extract';
import { isCreator, requireCreator, sessionCreatorSlug } from './auth';
import { loadBrief, type BriefRow } from './briefs';
import type { IntakeDeps } from './intake';
import type { GrantDeps } from './grant';
import { invoiceApiFromEnv, type InvoiceApi } from './paypal/invoices';
import { paymentsApiFromEnv, type PaymentsApi } from './paypal/payments';
import { ipHashOf, rateLimit } from './rate-limit';
import { clientIp } from './auth';
import { runAutopilot, type AutopilotResult } from './send';

// Next bundles pages and route handlers apart, each with its own copy of this module. A variable here gave each its own
// database: on PGlite a page opened first never saw a later payment (click review 1). One per process, for Postgres too.
const shared = globalThis as typeof globalThis & { __useRightDb?: Promise<Db> };

type DepsOverride = { db: Db; aiFor?: IntakeDeps['aiFor']; invoices?: InvoiceApi; payments?: PaymentsApi; uploadsDir?: string };
let override: DepsOverride | null = null;

/**
 * Tests only (B5 review 12, review 10, 12): route handlers use this database, AI and PayPal stand-in instead of
 * the env ones. Refused in production.
 */
export function setRouteDepsForTests(o: DepsOverride | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('route deps override is for tests only');
  override = o;
}

function getDb(): Promise<Db> {
  if (override) return Promise.resolve(override.db);
  shared.__useRightDb ??= openDb().then(async (db) => {
    await migrate(db);
    return db;
  });
  return shared.__useRightDb;
}

export async function deps(): Promise<IntakeDeps> {
  return {
    db: await getDb(),
    aiFor: override?.aiFor ?? ((fixture) => adapterFromEnv(process.env, fixture ?? undefined)),
    uploadsDir: override?.uploadsDir ?? process.env.UPLOADS_DIR ?? './.uploads',
  };
}

export function session(req: Request) {
  return { creator: isCreator(req.headers), sessionSlug: sessionCreatorSlug() };
}

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Creator gate for a route: returns the error Response, or null when the request may proceed. */
export function guard(req: Request): Response | null {
  const a = requireCreator(req);
  return a.ok ? null : json({ error: a.error }, a.status);
}

/** Resolves the session creator's id (404 Response when the creator row is missing). */
export async function creatorId(db: Db): Promise<string | Response> {
  const [row] = await db.query<{ id: string }>(`select id from creators where slug = $1`, [sessionCreatorSlug()]);
  return row ? row.id : json({ error: 'creator not found; run npm run db:seed' }, 404);
}

export const DEFAULT_BODY_LIMIT = 1024 * 1024;

/**
 * Reads a JSON body of at most `maxBytes` (code-review fix 5). A larger Content-Length is refused before any read;
 * a chunked body is cut off as soon as it passes the limit. 413 / 400 come back as Responses.
 */
export async function readJson(req: Request, maxBytes = DEFAULT_BODY_LIMIT): Promise<unknown | Response> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return json({ error: `body larger than ${maxBytes} bytes` }, 413);
  if (!req.body) return json({ error: 'body must be JSON' }, 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return json({ error: `body larger than ${maxBytes} bytes` }, 413);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }
}

/**
 * Batch-6 review F10: the raw body as text, reading at most `maxBytes`. A larger declared or streamed body is
 * cancelled at the limit and never buffered past it (null). The accepted bytes are decoded once and returned exactly
 * as sent, never parsed and re-serialised.
 */
export async function readRawBody(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await req.body?.cancel().catch(() => {});
    return null;
  }
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  // Fix round 2 (review nit 8, review nit 21): byte-exact decode; a BOM is kept and invalid UTF-8 throws (the route answers 400).
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

/** Loads a brief the session creator owns (code-review fix 7); 404 Response otherwise. */
export async function ownedBrief(db: Db, briefId: string): Promise<BriefRow | Response> {
  const me = await creatorId(db);
  if (me instanceof Response) return me;
  const brief = await loadBrief(db, briefId);
  return brief && brief.creator_id === me ? brief : json({ error: 'brief not found' }, 404);
}


/** PayPal Invoicing for route handlers. Credentials are read at the first PayPal call, not at import. */
export const invoices = (): InvoiceApi => override?.invoices ?? invoiceApiFromEnv();
export const payments = (): PaymentsApi => override?.payments ?? paymentsApiFromEnv();

/** Batch 6: what grantIfPaid, revocation and the webhook need. */
export async function grantDeps(): Promise<GrantDeps> {
  const d = await deps();
  return { db: d.db, uploadsDir: d.uploadsDir, pp: { invoices: invoices(), payments: payments() } };
}

/** Batch-6 fix 10: per-IP budget for a public endpoint; a 429 Response when spent. */
export async function publicLimit(req: Request, db: Db, kind: string, max: number): Promise<Response | null> {
  const ok = await db.transaction((tx) => rateLimit(tx, kind, ipHashOf(clientIp(req.headers)), max));
  return ok ? null : json({ error: 'too many requests from this address; try again later' }, 429);
}

/** Fix 22: public pay/download/receipt responses never leak their URL through Referer. */
export const PUBLIC_HEADERS = { 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } as const;
export const publicJson = (body: unknown, status = 200) => Response.json(body, { status, headers: PUBLIC_HEADERS });

/**
 * Batch-5 fix 11: after any route saves an extraction, a ready deal with client + photo is quoted and, if all
 * five rules pass, invoiced with no creator click. Never fails the request: problems land on the deal.
 */
export async function autopilot(db: Db, briefId: string): Promise<AutopilotResult | null> {
  try {
    return await runAutopilot(db, invoices(), briefId);
  } catch (err) {
    console.warn('[autopilot]', err instanceof Error ? err.name : 'error');
    return null;
  }
}
