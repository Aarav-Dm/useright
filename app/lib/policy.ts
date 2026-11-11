// Policy engine R1-R5 (batch-5 §2, fixes 4, 7, 15, 17, 19). One transaction under
// pg_advisory_xact_lock(hashtext(creator_id::text)); each rule result is an events row (kind 'rule').
import type { Db, Queryable } from '../db/client';
import type { PolicyResult, RuleResult } from './briefs';
import { unsellable } from './policy-flags';
import { scopeOptionIds, type Scope } from './pricing';
import { loadVersion, newOptionIds, type VersionRow } from './versions';

export const RESERVATION_MS = 15 * 60 * 1000;
export const MIN_INVOICE_CENTS = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type PolicyMode = 'autopilot' | 'approval';
export type EvaluateResult =
  | { ok: true; version: VersionRow; policy: PolicyResult; reservationId: string | null }
  | { ok: false; status: 404 | 409; error: string };

/** Creator-wide lock shared by autopilot and approval (fixes 4, 17). */
export async function lockCreator(tx: Queryable, creatorId: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtext($1::text))`, [creatorId]);
}

/** Wall-clock fields of `t` in `tz`. */
function wallClock(tz: string, t: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return { y: +parts.year!, m: +parts.month!, d: +parts.day!, h: +parts.hour!, min: +parts.minute!, s: +parts.second! };
}

/** tz's offset from UTC at instant t, in ms (local wall clock minus UTC). */
function offsetAt(tz: string, t: number): number {
  const w = wallClock(tz, t);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(t / 1000) * 1000;
}

/**
 * Midnight today in `tz`, as a UTC instant (daily max counts sends since then). B5 review 8: the offset
 * is the one in force at that midnight, not at `now`, so clock-change days (e.g. Nov 1 and Mar 8, 2026 in
 * New York) start at the right instant.
 */
export function startOfDayIn(tz: string, now: Date): Date {
  const { y, m, d } = wallClock(tz, now.getTime());
  return zonedMidnight(tz, y, m, d);
}

/** The calendar day of instant `t` in `tz` (month 1-12). */
export function localDay(tz: string, t: Date): { y: number; m: number; d: number } {
  const { y, m, d } = wallClock(tz, t.getTime());
  return { y, m, d };
}

/** Local midnight of calendar day y-m-d (month 1-12) in `tz`, as a UTC instant (batch-6 review F12). */
export function zonedMidnight(tz: string, y: number, m: number, d: number): Date {
  const localMidnight = Date.UTC(y, m - 1, d);
  let t = localMidnight - offsetAt(tz, localMidnight);
  t = localMidnight - offsetAt(tz, t); // second pass settles on the offset at midnight itself
  return new Date(t);
}

const rule = (r: string, pass: boolean, code: string, message: string): RuleResult => ({ rule: r, pass, code, message });
const usd = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The rules, read-only. Hard blocks (amount_too_small, missing_client_email) stop approval too. */
async function runRules(tx: Queryable, v: VersionRow, mode: PolicyMode, now: Date): Promise<PolicyResult> {
  const [s] = await tx.query<{ per_deal_cap_cents: number; daily_max_sends: number; rolling30_cap_cents: number; auto_channels: string[]; timezone: string }>(
    `select * from creator_settings where creator_id = $1`, [v.creator_id]);
  const [client] = await tx.query<{ allowed: boolean; email: string }>(`select allowed, email from clients where id = $1`, [v.client_id]);
  const [x] = await tx.query<{ status: string; reasons: string[] }>(`select status, reasons from extractions where id = $1`, [v.extraction_id]);
  const results: RuleResult[] = [];

  // Hard blocks first (fixes 15, 19): no PayPal call can succeed without them.
  if (v.total_cents < MIN_INVOICE_CENTS) results.push(rule('MIN', false, `amount_too_small:${v.total_cents}`, `${usd(v.total_cents)} is below PayPal's $1.00 minimum for an invoice.`));
  if (!client?.email || !EMAIL_RE.test(client.email)) results.push(rule('EMAIL', false, 'missing_client_email', 'The client has no valid email address to send the invoice to.'));
  const hardBlock = results.length > 0;
  if (mode === 'autopilot') {
    const [brief] = await tx.query<{ confirmed_on_page: boolean }>(`select confirmed_on_page from briefs where id = $1`, [v.brief_id]);
    if (brief?.confirmed_on_page) results.push(rule('Identity', false, 'confirmed_on_page', 'Confirmed on the page, not by email. This request needs your approval.'));
  }

  results.push(client?.allowed
    ? rule('R1', true, 'client_allowed', 'The client is on your allowed list.')
    : rule('R1', false, 'client_not_allowed', 'This client is not on your list of clients the agent may invoice.'));

  const cap = s?.per_deal_cap_cents ?? 0;
  results.push(v.total_cents <= cap
    ? rule('R2', true, 'under_deal_cap', `${usd(v.total_cents)} is within your ${usd(cap)} per-deal cap.`)
    : rule('R2', false, `over_deal_cap:${v.total_cents}:${cap}`, `${usd(v.total_cents)} exceeds your ${usd(cap)} per-deal cap.`));

  // R3 (fix 4): live = sent, or reserved and not expired. Daily per creator in her timezone; 30 days per client.
  // review 9: a sent row counts by when it actually went out (sent_at); every still-live reservation counts.
  // review re-check 1: a reservation whose invoice may be live (unresolved send) counts until it is reconciled, even expired.
  const inWindow = `((status = 'sent' and coalesce(sent_at, created_at) >= $3) or (status = 'reserved' and (expires_at > $2
    or exists (select 1 from invoices i where i.version_id = autopilot_sends.version_id and i.state not in ('cancelled')))))`;
  const [{ n: today } = { n: 0 }] = await tx.query<{ n: number }>(
    `select count(*)::int as n from autopilot_sends where creator_id = $1 and ${inWindow} and version_id <> $4`,
    [v.creator_id, now, startOfDayIn(s?.timezone ?? 'America/New_York', now), v.id]);
  const [{ sum } = { sum: 0 }] = await tx.query<{ sum: number }>(
    `select coalesce(sum(amount_cents), 0)::int as sum from autopilot_sends where client_id = $1 and ${inWindow} and version_id <> $4`,
    [v.client_id, now, new Date(now.getTime() - 30 * 24 * 3600 * 1000), v.id]);
  const daily = s?.daily_max_sends ?? 0;
  const rolling = s?.rolling30_cap_cents ?? 0;
  if (today >= daily) results.push(rule('R3', false, `daily_max_reached:${today}`, `The agent already sent ${today} invoice${today === 1 ? '' : 's'} today, your daily maximum.`));
  else if (sum + v.total_cents > rolling) {
    results.push(rule('R3', false, `rolling_cap_reached:${sum + v.total_cents}:${rolling}`, `This would bring the client to ${usd(sum + v.total_cents)} in 30 days, over your ${usd(rolling)} cap.`));
  } else results.push(rule('R3', true, 'within_send_limits', `${today} of ${daily} sends today; client at ${usd(sum + v.total_cents)} of ${usd(rolling)} in 30 days.`));

  // B8 review fix 4 (spec wins): a renewal re-sells its whole scope, so R4 checks every renewed option, not only new
  // ones; an ask-only channel (billboard) always waits for typed approval.
  const blocked = unsellable(v.renewal_of ? scopeOptionIds(v.scope) : await newOptionIds(tx, v), { autoChannels: s?.auto_channels ?? [] });
  if (blocked.length === 0) results.push(rule('R4', true, 'all_sellable', v.renewal_of ? 'Every renewed option is one the agent may sell on its own.' : 'Every new option is one the agent may sell on its own.'));
  for (const id of blocked) {
    const label = id === 'exclusive' ? 'Exclusive rights' : id === 'OOH' ? 'Out-of-home' : id[0]!.toUpperCase() + id.slice(1);
    results.push(rule('R4', false, `needs_approval:${id}`, `${label} needs your approval.`));
  }

  // Batch 8 plan fix 3: a renewal (renewal_of set) whose scope equals its parent's read no new words, so R5 passes
  // structurally; a renewal with any other scope falls through to the normal extraction check (and fails without one).
  const [renews] = v.renewal_of
    ? await tx.query<{ scope: Scope; renewal_opt_in: boolean }>(`select scope, renewal_opt_in from licence_versions where id = $1`, [v.renewal_of])
    : [];
  if (renews && sameScope(v.scope, renews.scope)) {
    results.push(rule('R5', true, 'renewal_same_scope', 'Renewal of the same licence: nothing new was read.'));
  } else {
    results.push(x?.status === 'ready' && x.reasons.length === 0
      ? rule('R5', true, 'checks_clear', 'Every request check is clear.')
      : rule('R5', false, 'checks_not_clear', 'The request checks are not all clear.'));
  }
  // Batch 8 plan fix 4: a renewal the client did not ask for waits in Ask me as "Renew?". Only autopilot asks this;
  // the creator's typed approval is the OK.
  if (renews && mode === 'autopilot' && !renews.renewal_opt_in) {
    results.push(rule('RENEW', false, RENEWAL_NEEDS_OK, 'The client did not ask for a renewal invoice, so this renewal waits for your OK.'));
  }

  return { pass: results.every((r) => r.pass), hardBlock, results, evaluatedAt: now.toISOString(), mode };
}

export const RENEWAL_NEEDS_OK = 'renewal_needs_ok';

/** Same licence scope: same channel set, territory, term and exclusivity. */
export function sameScope(a: Scope, b: Scope): boolean {
  const ca = [...a.channels].sort().join(',');
  const cb = [...b.channels].sort().join(',');
  return ca === cb && a.territory === b.territory && a.durationMonths === b.durationMonths && a.exclusive === b.exclusive;
}

/**
 * evaluate(versionId) (fix 7). Releases expired reservations, runs the rules on the pending version, logs one
 * event per rule and stores the result on the version. In autopilot mode an all-pass result reserves a send
 * slot (15 min) in the same transaction; approval mode never touches autopilot_sends (fix 4).
 */
export async function evaluate(db: Db, versionId: string, opts: { mode?: PolicyMode; now?: Date; demoDate?: Date } = {}): Promise<EvaluateResult> {
  const mode = opts.mode ?? 'autopilot';
  const now = opts.now ?? new Date();
  const head = await loadVersion(db, versionId);
  if (!head) return { ok: false, status: 404, error: 'quote not found' };
  return db.transaction(async (tx) => {
    await lockCreator(tx, head.creator_id);
    // B5 review 4: never free capacity for a version whose invoice may be live.
    await tx.query(
      `update autopilot_sends s set status = 'released'
        where s.creator_id = $1 and s.status = 'reserved' and s.expires_at <= $2
          and not exists (select 1 from invoices i where i.version_id = s.version_id and i.state <> 'cancelled')`,
      [head.creator_id, now]);
    const v = await loadVersion(tx, versionId, true);
    if (!v || v.status !== 'pending') return { ok: false as const, status: 409 as const, error: 'this quote is no longer open' };
    const policy = await runRules(tx, v, mode, now);
    // B8 review fix 7: with `demoDate` (the demo tick), the rules judge at `now` but their ledger rows carry real time
    // and name the demo date in the detail. Without it nothing changes: rows are stamped `now`.
    const stamp = opts.demoDate ? new Date() : now;
    for (const r of policy.results) {
      await tx.query(`insert into events (creator_id, kind, rule, detail, created_at) values ($1, 'rule', $2, $3, $4)`, [
        v.creator_id, r.rule, JSON.stringify({ briefId: v.brief_id, versionId: v.id, pass: r.pass, code: r.code, message: r.message, mode,
          ...(opts.demoDate ? { demoDate: opts.demoDate.toISOString() } : {}) }), stamp,
      ]);
    }
    await tx.query(`update licence_versions set policy = $1 where id = $2`, [JSON.stringify(policy), v.id]);
    let reservationId: string | null = null;
    if (mode === 'autopilot' && policy.pass) {
      const [live] = await tx.query<{ id: string }>(`select id from autopilot_sends where version_id = $1 and status in ('reserved', 'sent')`, [v.id]);
      if (live) reservationId = live.id;
      else {
        const [r] = await tx.query<{ id: string }>(
          `insert into autopilot_sends (creator_id, client_id, version_id, status, amount_cents, expires_at, created_at)
           values ($1, $2, $3, 'reserved', $4, $5, $6) returning id`,
          [v.creator_id, v.client_id, v.id, v.total_cents, new Date(now.getTime() + RESERVATION_MS), now]);
        reservationId = r!.id;
      }
    }
    return { ok: true as const, version: v, policy, reservationId };
  });
}
