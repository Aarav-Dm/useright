// Per-IP request budget for public endpoints (batch-6 fix 10, extracted from intake). Only an IP hash is stored.
import type { Queryable } from '../db/client';
import { sha256Hex } from './hash';

export const ipHashOf = (ip: string) => sha256Hex(`ip:${ip}`);

export const RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Records one hit of `kind` for `ipHash` and returns false when the hour already holds `max` hits.
 * Serialised per (kind, ip) with an advisory lock; run inside a transaction.
 * Batch-6 review F19: rows older than the window are pruned here. They are outside every window, so no
 * active count changes; rows inside the window are never deleted.
 */
export async function rateLimit(tx: Queryable, kind: string, ipHash: string, max: number, now: Date = new Date()): Promise<boolean> {
  await tx.query(`select pg_advisory_xact_lock(hashtext('rate:' || $1 || ':' || $2))`, [kind, ipHash]);
  const windowStart = new Date(now.getTime() - RATE_WINDOW_MS);
  // Expired against both the caller's clock and the database clock, so a test clock never prunes a live row.
  await tx.query(`delete from rate_hits where at <= least($1::timestamptz, now() - interval '1 hour')`, [windowStart]);
  const [{ n } = { n: 0 }] = await tx.query<{ n: number }>(
    `select count(*)::int as n from rate_hits where kind = $1 and ip_hash = $2 and at > $3 and at <= $4`,
    [kind, ipHash, windowStart, now]);
  if (n >= max) return false;
  await tx.query(`insert into rate_hits (kind, ip_hash, at) values ($1, $2, $3)`, [kind, ipHash, now]);
  return true;
}
