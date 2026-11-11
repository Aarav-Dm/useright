// One intake handler (batch-3 §1, §7 fixes 3, 4, 8, 11). Framework-free; routes are thin wrappers.
import { z } from 'zod';
import type { Db, Queryable } from '../db/client';
import { fixtureModeAllowed } from './ai/extract';
import type { ImageInput, Transcript } from './ai/types';
import { extractBrief, loadBrief, saveTranscript, type AiFor, type BriefState, type ExtractionRow, type IntakeSource } from './briefs';
import { ipHashOf, rateLimit } from './rate-limit';
import { hashToken, newToken } from './tokens';
import { saveUpload } from './storage';

export const RATE_LIMIT_PER_HOUR = 20;
export const IP_LIMIT_PER_HOUR = 5;
export const VERIFY_TTL_MS = 30 * 60 * 1000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Code-review fix 5: base64 of a 5 MB image is ~6.7M chars; 7M leaves headroom, and the body cap is 8 MB. */
export const MAX_IMAGE_BASE64 = 7_000_000;
export const MAX_INTAKE_BODY_BYTES = 8 * 1024 * 1024;
export const UNKNOWN_SENDER = 'unknown';

export type IntakeDeps = {
  db: Db;
  aiFor: AiFor;
  uploadsDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

const uuid = z.string().uuid();
const email = z.string().trim().toLowerCase().email().max(254);
const text = z.string().trim().min(1).max(20_000);
const fixture = z.string().regex(/^[a-z0-9-]+$/).max(64).optional();

export const IntakeInputSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('paste'),
    clientId: z.union([uuid, z.literal(UNKNOWN_SENDER)]),
    assetId: uuid,
    text,
    claimedSender: z.string().trim().max(200).optional(),
    fixture,
  }),
  z.object({
    source: z.literal('screenshot'),
    clientId: z.union([uuid, z.literal(UNKNOWN_SENDER)]),
    assetId: uuid,
    image: z.object({ mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), base64: z.string().min(1).max(MAX_IMAGE_BASE64) }),
    claimedSender: z.string().trim().max(200).optional(),
    fixture,
  }),
  z.object({ source: z.literal('portfolio'), assetId: uuid, email, name: z.string().trim().max(200).optional(), text, fixture, confirmOnPage: z.boolean().optional() }),
  z.object({
    source: z.literal('form'),
    creatorSlug: z.string().regex(/^[a-z0-9-]+$/).max(64),
    assetId: uuid.optional(),
    email,
    name: z.string().trim().max(200).optional(),
    text,
    fixture,
  }),
]);
export type IntakeInput = z.infer<typeof IntakeInputSchema>;

export type IntakeOk = {
  ok: true;
  briefId: string;
  state: BriefState;
  clientId: string | null;
  extraction: ExtractionRow | null;
  transcriptError?: 'ai_invalid';
  /** Only a page-purpose token is public; it cannot be used to verify an email address. */
  confirmation?: { token: string };
};
export type IntakeErr = { ok: false; status: 400 | 401 | 404 | 409 | 429; error: string };

const err = (status: IntakeErr['status'], error: string): IntakeErr => ({ ok: false, status, error });

/**
 * Request text -> transcript. Only the creator's own paste may carry `client:` / `creator:` / `unknown:` labels
 * (every line labelled = labels kept). Public sources (form, portfolio) never honour labels: a requester could
 * otherwise mark their own words as the creator's and hide them from the checks. Every line is the client's.
 */
export function pasteToTranscript(raw: string, honourLabels = false): Transcript {
  const rows = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const label = /^(client|creator|unknown)\s*:\s*(.*)$/i;
  if (honourLabels && rows.length > 0 && rows.every((r) => label.test(r))) {
    return {
      lines: rows.map((r) => {
        const m = label.exec(r)!;
        return { speaker: m[1]!.toLowerCase() as 'client' | 'creator' | 'unknown', text: m[2]! };
      }),
    };
  }
  return { lines: rows.map((r) => ({ speaker: 'client' as const, text: r })) };
}

function decodeImage(image: ImageInput): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) return null;
  const buf = Buffer.from(image.base64, 'base64');
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  const magic: Record<ImageInput['mime'], (b: Buffer) => boolean> = {
    'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  };
  return magic[image.mime](buf) ? buf : null;
}

// Batch-6 review F19: the shared token helpers (same sha256-hex format, so stored verification hashes stay valid).
export { hashToken };

async function resolveCreator(q: Queryable, input: IntakeInput, sessionSlug: string) {
  if (input.source === 'paste' || input.source === 'screenshot') {
    return (await q.query<{ id: string }>(`select id from creators where slug = $1`, [sessionSlug]))[0]?.id ?? null;
  }
  if (input.source === 'portfolio') {
    // Public intake only for public assets; the asset decides the creator.
    return (await q.query<{ creator_id: string }>(`select creator_id from assets where id = $1 and is_public`, [input.assetId]))[0]?.creator_id ?? null;
  }
  return (await q.query<{ id: string }>(`select id from creators where slug = $1`, [input.creatorSlug]))[0]?.id ?? null;
}

/**
 * Stores a brief and moves it as far as it can go:
 * paste -> transcript + extraction now; screenshot -> draft transcript, waits for the creator to confirm;
 * portfolio -> waits for email or explicit page confirmation; form -> extraction now, client set after email verification.
 */
export async function intake(
  deps: IntakeDeps,
  rawInput: unknown,
  /** `ip`: the requester's address as resolved by the route (clientIp). Omitted only by in-process callers. */
  auth: { creator: boolean; sessionSlug: string; ip?: string },
  /** Runs first in the transaction that stores the brief; an error stops it. Only the demo panel's fresh deal uses it. */
  inTransaction?: (tx: Queryable) => Promise<IntakeErr | null>,
): Promise<IntakeOk | IntakeErr> {
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  const rawSource = (rawInput as { source?: unknown } | null)?.source;
  if ((rawSource === 'paste' || rawSource === 'screenshot') && !auth.creator) return err(401, 'creator session required');
  const parsed = IntakeInputSchema.safeParse(rawInput);
  if (!parsed.success) return err(400, `invalid intake: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}`);
  const input = parsed.data;
  const creatorOnly = input.source === 'paste' || input.source === 'screenshot';
  const onPage = input.source === 'portfolio' && input.confirmOnPage === true;
  if (creatorOnly && !auth.creator) return err(401, 'creator session required');
  // Code-review fix 6: a client-supplied fixture name only counts in fixture mode outside production.
  const fixtureName = fixtureModeAllowed(env) ? (input.fixture ?? null) : null;
  const ipHash = !creatorOnly && auth.ip !== undefined ? ipHashOf(auth.ip) : null;

  let image: Buffer | null = null;
  if (input.source === 'screenshot') {
    image = decodeImage(input.image);
    if (!image) return err(400, 'image must be a PNG, JPEG or WebP up to 5 MB');
  }

  const created = await deps.db.transaction(async (tx): Promise<IntakeErr | { briefId: string; creatorId: string; clientId: string | null; state: BriefState; verifyToken?: string }> => {
    const stop = await inTransaction?.(tx);
    if (stop) return stop;
    const creatorId = await resolveCreator(tx, input, auth.sessionSlug);
    if (!creatorId) return err(404, 'creator or asset not found');

    // Rate limit (§1, code-review fix 3): anonymous sources only. Counts this creator's public briefs in the
    // last hour, serialised per creator; the creator's own paste/screenshot is never blocked by that traffic.
    if (!creatorOnly) {
      await tx.query(`select pg_advisory_xact_lock(hashtext('intake:' || $1::text))`, [creatorId]);
      const [{ n } = { n: 0 }] = await tx.query<{ n: number }>(
        `select count(*)::int as n from briefs
          where creator_id = $1 and source in ('portfolio', 'form') and created_at > $2 and created_at <= $3`,
        [creatorId, new Date(now.getTime() - 60 * 60 * 1000), now],
      );
      if (n >= RATE_LIMIT_PER_HOUR) return err(429, `rate limit: ${RATE_LIMIT_PER_HOUR} intakes per hour`);

      // review P4: also 5 public intakes per hour per requester IP, across all creators. Only a hash of the IP is kept.
      // Batch-6 fix 10: the same rateLimit() the pay page uses, with its own budget.
      if (ipHash && !(await rateLimit(tx, 'intake', ipHash, IP_LIMIT_PER_HOUR, now))) {
        return err(429, `rate limit: ${IP_LIMIT_PER_HOUR} requests per hour from this address`);
      }
    }

    if (input.assetId) {
      const a = await tx.query(`select 1 from assets where id = $1 and creator_id = $2`, [input.assetId, creatorId]);
      if (a.length === 0) return err(404, 'asset not found');
    }

    // A2 identity: only the creator's explicit pick. Public sources start with no client.
    let clientId: string | null = null;
    if (creatorOnly && input.clientId !== UNKNOWN_SENDER) {
      const c = await tx.query(`select 1 from clients where id = $1 and creator_id = $2`, [input.clientId, creatorId]);
      if (c.length === 0) return err(404, 'client not found');
      clientId = input.clientId;
    }

    const state: BriefState = input.source === 'portfolio' || onPage ? 'awaiting_verification' : 'awaiting_transcript';
    const claimed = creatorOnly ? (input.claimedSender ?? null) : (input.name ? `${input.name} <${input.email}>` : input.email);
    const [brief] = await tx.query<{ id: string }>(
      `insert into briefs (creator_id, client_id, source, raw, asset_id, claimed_sender, state, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [creatorId, clientId, input.source, 'text' in input ? input.text : null, input.assetId ?? null, claimed, state, now],
    );
    const briefId = brief!.id;
    await tx.query(`insert into events (creator_id, kind, detail, created_at) values ($1, 'intake.created', $2, $3)`, [
      creatorId, JSON.stringify({ briefId, source: input.source, fixture: fixtureName, ...(ipHash ? { ipHash } : {}) }), now,
    ]);

    let verifyToken: string | undefined;
    if (input.source === 'portfolio' || input.source === 'form') {
      verifyToken = newToken();
      await tx.query(
        `insert into email_verifications (token, creator_id, email, brief_id, expires_at, confirmation_channel) values ($1, $2, $3, $4, $5, $6)`,
        [hashToken(verifyToken), creatorId, input.email, briefId, new Date(now.getTime() + VERIFY_TTL_MS), onPage ? 'page' : 'email'],
      );
    }
    return { briefId, creatorId, clientId, state, verifyToken };
  });
  if ('ok' in created) return created;

  const out: IntakeOk = { ok: true, briefId: created.briefId, state: created.state, clientId: created.clientId, extraction: null };
  if (onPage && created.verifyToken) out.confirmation = { token: created.verifyToken };
  // Email-purpose tokens stay private. A page-purpose token is public but cannot verify email ownership.
  const brief = (await loadBrief(deps.db, created.briefId))!;

  if (input.source === 'screenshot') {
    if (!image) return err(400, 'image missing');
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[input.image.mime];
    const path = await saveUpload(deps.uploadsDir, `${brief.id}.${ext}`, image);
    await deps.db.query(`update briefs set upload_path = $1 where id = $2`, [path, brief.id]);
    // Draft transcript for the creator to check; extraction waits for her confirm.
    const t = await deps.aiFor(fixtureName).transcribe(input.image);
    await saveTranscript(deps.db, brief, t.ok ? t.value : { lines: [] }, false);
    if (!t.ok) out.transcriptError = 'ai_invalid';
    return out;
  }
  if (input.source === 'paste' || input.source === 'form') {
    await saveTranscript(deps.db, brief, pasteToTranscript(input.text, input.source === 'paste'), true);
    out.extraction = await extractBrief(deps.db, deps.aiFor, brief.id);
    out.state = 'extracted';
    return out;
  }
  // Public requests awaiting either confirmation keep client-only text; extraction waits.
  await saveTranscript(deps.db, brief, pasteToTranscript(input.text, false), true);
  return out;
}

export type VerifyResult =
  | { ok: true; briefId: string; clientId: string; extraction: ExtractionRow | null }
  | { ok: false; status: 400 | 404 | 410; error: string };

/** Consume a purpose-bound token; page confirmation marks the request for creator approval, never email ownership. */
export async function verifyEmail(deps: IntakeDeps, token: string, channel: 'email' | 'page' = 'email'): Promise<VerifyResult> {
  const now = deps.now?.() ?? new Date();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { ok: false, status: 400, error: 'bad token' };
  const res = await deps.db.transaction(async (tx) => {
    const [v] = await tx.query<{ creator_id: string; email: string; brief_id: string; expires_at: Date; used_at: Date | null; confirmation_channel: 'email' | 'page' }>(
      `select creator_id, email, brief_id, expires_at, used_at, confirmation_channel from email_verifications where token = $1 for update`,
      [hashToken(token)],
    );
    if (!v) return { ok: false as const, status: 404 as const, error: 'link not found' };
    if (v.confirmation_channel !== channel) return { ok: false as const, status: 400 as const, error: 'this token is for a different confirmation method' };
    if (v.used_at) return { ok: false as const, status: 410 as const, error: 'link already used' };
    if (v.expires_at.getTime() <= now.getTime()) return { ok: false as const, status: 410 as const, error: 'link expired' };
    await tx.query(`update email_verifications set used_at = $1 where token = $2`, [now, hashToken(token)]);
    const [brief] = await tx.query<{ claimed_sender: string | null; state: BriefState }>(
      `select claimed_sender, state from briefs where id = $1`, [v.brief_id]);
    const name = brief?.claimed_sender?.replace(/\s*<[^>]*>$/, '') || v.email;
    // Existing client rows keep their `allowed` flag; new ones start not allowed.
    const [client] = await tx.query<{ id: string }>(
      `insert into clients (creator_id, name, email, allowed) values ($1, $2, $3, false)
       on conflict (creator_id, lower(email)) do update set email = clients.email
       returning id`,
      [v.creator_id, name, v.email],
    );
    await tx.query(`update briefs set client_id = $1, confirmed_on_page = confirmed_on_page or $3 where id = $2`, [client!.id, v.brief_id, channel === 'page']);
    await tx.query(`update transcripts set client_id = $1 where brief_id = $2`, [client!.id, v.brief_id]);
    if (brief?.state === 'awaiting_verification') {
      await tx.query(`update briefs set state = 'awaiting_transcript' where id = $1`, [v.brief_id]);
    }
    return { ok: true as const, briefId: v.brief_id, clientId: client!.id };
  });
  if (!res.ok) return res;
  // form briefs were extracted at intake; re-run so the check result reflects the now-known client.
  const extraction = await extractBrief(deps.db, deps.aiFor, res.briefId);
  return { ok: true, briefId: res.briefId, clientId: res.clientId, extraction };
}


export type VerifyLink =
  | { ok: true; url: string; email: string; expiresAt: Date }
  | { ok: false; status: 404 | 409; error: string };

/**
 * review P1 demo stand-in for outbound email: the authenticated creator gets a fresh one-time link for a brief
 * still waiting on its requester's email. Only token hashes are stored, so a new token is issued and every
 * older unused one for the brief is voided. The link confirms the requester's address; the client it creates
 * stays allowed=false.
 */
export async function issueVerifyLink(db: Db, creatorId: string, briefId: string, now: Date = new Date()): Promise<VerifyLink> {
  return db.transaction(async (tx) => {
    const [brief] = await tx.query<{ creator_id: string }>(`select creator_id from briefs where id = $1 for update`, [briefId]);
    if (!brief || brief.creator_id !== creatorId) return { ok: false as const, status: 404 as const, error: 'brief not found' };
    const [pending] = await tx.query<{ email: string }>(
      `select email from email_verifications where brief_id = $1 and used_at is null order by seq desc limit 1`,
      [briefId],
    );
    if (!pending) return { ok: false as const, status: 409 as const, error: 'nothing waiting for email verification' };
    await tx.query(`update email_verifications set used_at = $1, expires_at = least(expires_at, $1) where brief_id = $2 and used_at is null`, [now, briefId]);
    const token = newToken();
    const expiresAt = new Date(now.getTime() + VERIFY_TTL_MS);
    await tx.query(
      `insert into email_verifications (token, creator_id, email, brief_id, expires_at) values ($1, $2, $3, $4, $5)`,
      [hashToken(token), creatorId, pending.email, briefId, expiresAt],
    );
    await tx.query(`insert into events (creator_id, kind, detail) values ($1, 'verify_link.issued', $2)`, [creatorId, JSON.stringify({ briefId })]);
    return { ok: true as const, url: `/api/verify/${token}`, email: pending.email, expiresAt };
  });
}
