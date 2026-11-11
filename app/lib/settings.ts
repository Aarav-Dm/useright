// Creator settings (batch-4 §4, §6 fix 4). Server validates everything; the screen is a plain form.
import { z } from 'zod';
import type { Db } from '../db/client';
import { CHANNELS, DEFAULT_CARD, optionKind, type PricedOptionId, type RateCard } from './pricing';

export const PRICED_OPTION_IDS = Object.keys(DEFAULT_CARD) as PricedOptionId[];
export const SELLABLE = [...CHANNELS, 'exclusive'] as const;
const MAX_CENTS = 100_000_000; // $1,000,000; keeps sums inside int4

const cents = z.number().int().min(0).max(MAX_CENTS);
const sellable = z.array(z.enum(SELLABLE)).max(SELLABLE.length).refine((a) => new Set(a).size === a.length, 'duplicate entries');

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const SettingsSchema = z
  .object({
    rateCard: z.object(Object.fromEntries(PRICED_OPTION_IDS.map((id) => [id, cents])) as Record<PricedOptionId, typeof cents>).strict(),
    perDealCapCents: cents,
    dailyMaxSends: z.number().int().min(0).max(1000),
    rolling30CapCents: cents,
    autoChannels: sellable,
    askChannels: sellable,
    allowedClientIds: z.array(z.string().uuid()).max(1000),
    timezone: z.string().min(1).max(64).refine(isTimeZone, 'unknown time zone'),
  })
  .strict()
  .superRefine((s, ctx) => {
    const overlap = s.autoChannels.filter((c) => s.askChannels.includes(c));
    if (overlap.length) ctx.addIssue({ code: 'custom', path: ['askChannels'], message: `in both auto and ask: ${overlap.join(', ')}` });
  });
export type Settings = z.infer<typeof SettingsSchema>;

export type SettingsView = Settings & { clients: { id: string; name: string; email: string; allowed: boolean }[] };

export async function getSettings(db: Db, creatorId: string): Promise<SettingsView> {
  const [s] = await db.query<{ per_deal_cap_cents: number; daily_max_sends: number; rolling30_cap_cents: number; auto_channels: string[]; ask_channels: string[]; timezone: string }>(
    `select * from creator_settings where creator_id = $1`, [creatorId]);
  const card = await db.query<{ option_id: PricedOptionId; cents: number }>(`select option_id, cents from rate_card_options where creator_id = $1`, [creatorId]);
  const clients = await db.query<SettingsView['clients'][number]>(`select id, name, email, allowed from clients where creator_id = $1 order by name`, [creatorId]);
  // Options missing from the table fall back to the default card so the form always has 11 fields.
  const rateCard = { ...DEFAULT_CARD, ...Object.fromEntries(card.map((r) => [r.option_id, r.cents])) } as RateCard;
  return {
    rateCard: { ...rateCard },
    perDealCapCents: s?.per_deal_cap_cents ?? 0,
    dailyMaxSends: s?.daily_max_sends ?? 0,
    rolling30CapCents: s?.rolling30_cap_cents ?? 0,
    autoChannels: (s?.auto_channels ?? []) as Settings['autoChannels'],
    askChannels: (s?.ask_channels ?? []) as Settings['askChannels'],
    allowedClientIds: clients.filter((c) => c.allowed).map((c) => c.id),
    timezone: s?.timezone ?? 'America/New_York',
    clients,
  };
}

export type PutResult = { ok: true; settings: SettingsView } | { ok: false; status: 400; error: string; issues: { path: string; message: string }[] };

/** Replaces the settings in one transaction. Existing licence versions keep their frozen card (they never read this table). */
export async function putSettings(db: Db, creatorId: string, body: unknown): Promise<PutResult> {
  const parsed = SettingsSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.') || 'body', message: i.message }));
    return { ok: false, status: 400, error: 'invalid settings', issues };
  }
  const s = parsed.data;
  const bad = await db.query<{ id: string }>(
    `select id from unnest($1::uuid[]) as id where id not in (select id from clients where creator_id = $2)`,
    [s.allowedClientIds, creatorId],
  );
  if (bad.length) return { ok: false, status: 400, error: 'invalid settings', issues: [{ path: 'allowedClientIds', message: `unknown client ${bad[0]!.id}` }] };

  await db.transaction(async (tx) => {
    await tx.query(
      `insert into creator_settings (creator_id, per_deal_cap_cents, daily_max_sends, rolling30_cap_cents, auto_channels, ask_channels, timezone)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (creator_id) do update set per_deal_cap_cents = excluded.per_deal_cap_cents, daily_max_sends = excluded.daily_max_sends,
         rolling30_cap_cents = excluded.rolling30_cap_cents, auto_channels = excluded.auto_channels,
         ask_channels = excluded.ask_channels, timezone = excluded.timezone`,
      [creatorId, s.perDealCapCents, s.dailyMaxSends, s.rolling30CapCents, s.autoChannels, s.askChannels, s.timezone],
    );
    for (const id of PRICED_OPTION_IDS) {
      await tx.query(
        `insert into rate_card_options (creator_id, option_id, kind, cents) values ($1, $2, $3, $4)
         on conflict (creator_id, option_id) do update set kind = excluded.kind, cents = excluded.cents`,
        [creatorId, id, optionKind(id), s.rateCard[id]],
      );
    }
    await tx.query(`update clients set allowed = (id = any($2::uuid[])) where creator_id = $1`, [creatorId, s.allowedClientIds]);
    await tx.query(`insert into events (creator_id, kind, detail) values ($1, 'settings.updated', $2)`, [creatorId, JSON.stringify(s)]);
  });
  return { ok: true, settings: await getSettings(db, creatorId) };
}
