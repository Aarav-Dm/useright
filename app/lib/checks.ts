// Code checks (batch-3 §3 + §7 fixes 2, 6, 9, 10). Pure: run after every extraction.
import type { Extraction, Transcript } from './ai/types';
import { OPTION_IDS } from './ai/prompts';
import { isPaidPromoReason, PAID_PROMO_TRIPWIRES } from './reasons';
import { CHANNELS, DURATIONS, TERRITORIES, combine, type Channel, type DurationMonths, type Scope, type Territory } from './pricing';

export type CheckStatus = 'ready' | 'needs_creator' | 'clarify';

export type KeptUse = { optionId: string; quote: string; lineIndex: number; sentence: string };
export type DroppedUse = { optionId: string; quote: string; reason: string };

export type CheckResult = {
  status: CheckStatus;
  requested: Scope | null;
  reasons: string[];
  kept: KeptUse[];
  dropped: DroppedUse[];
  clarifyingQuestion: string | null;
  /** Informational findings the creator already reviewed (creator edits only); never block. */
  notes: string[];
};

export const MIN_QUOTE_CHARS = 12;

/** Lowercase, strip straight and curly quotes, collapse whitespace, strip leading/trailing punctuation and bullets (fix 15). */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/['"\u2018\u2019\u201C\u201D]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
}

// Dots that do not end a sentence (fix 15). Replaced by a same-length placeholder before splitting.
const PROTECTED = /\b(?:u\.s\.a\.|u\.s\.|u\.k\.|e\.g\.|i\.e\.|etc\.|vs\.|approx\.|inc\.|ltd\.|mr\.|mrs\.|ms\.|dr\.)|\d\.(?=\d)/gi;
const MASK = '\u0000';

/**
 * Sentence spans (start/end offsets into `text`). Cuts after . ! ? followed by space or end, at newlines,
 * before a line-start bullet (`- ` or `* `) and before any `•`. Abbreviations and decimals do not cut.
 * `-`/`*` only count at a line start so "in-store" and "multi-year" stay whole.
 */
export function sentenceSpans(text: string): { start: number; end: number }[] {
  const masked = text.replace(PROTECTED, (m) => m.replace(/\./g, MASK));
  const cuts = new Set<number>([0, text.length]);
  for (const m of masked.matchAll(/[.!?]+(?=\s|$)/g)) cuts.add(m.index + m[0].length);
  for (const m of masked.matchAll(/\n/g)) { cuts.add(m.index); cuts.add(m.index + 1); }
  for (const m of masked.matchAll(/^[ \t]*[-*][ \t]+/gm)) cuts.add(m.index);
  for (const m of masked.matchAll(/•/g)) cuts.add(m.index);
  const points = [...cuts].sort((a, b) => a - b);
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    let start = points[i]!;
    let end = points[i + 1]!;
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    if (end > start && normalise(text.slice(start, end)).length > 0) spans.push({ start, end });
  }
  return spans;
}

/** Normalised sentences of a line, in order. */
export function sentences(text: string): string[] {
  return sentenceSpans(text).map((s) => normalise(text.slice(s.start, s.end)));
}

/** Index of the client line that contains `quote` as one complete sentence, or null. */
export function findQuote(transcript: Transcript, quote: string): { lineIndex: number; sentence: string } | null {
  const q = normalise(quote);
  if (q.length < MIN_QUOTE_CHARS) return null;
  for (const [i, line] of transcript.lines.entries()) {
    if (line.speaker !== 'client') continue;
    if (sentences(line.text).includes(q)) return { lineIndex: i, sentence: q };
  }
  return null;
}

// ---- quote must support its option (review P2) ----

/**
 * Words a quote must contain for its option id (case-insensitive, word boundaries, plurals allowed).
 * US and 6mo are the defaults and need no anchor. Matched against the normalised sentence.
 */
export const ANCHORS: Record<string, RegExp | null> = {
  print: /\b(?:print(?:s|ed|ing)?|posters?|flyers?|brochures?|magazines?|catalog(?:ue)?s?|packaging|in[- ]store signage|signage)\b/i,
  social: /\b(?:social|instagram|ig|tiktok|facebook|linkedin|posts?|stor(?:y|ies)|reels?)\b/i,
  web: /\b(?:web|websites?|site|online|blogs?|landing pages?|homepage)\b/i,
  billboard: /\bbillboards?\b/i,
  OOH: /\b(?:ooh|out[- ]of[- ]home|transit|bus(?:es)?|subway)\b/i,
  TV: /\b(?:tv|television|broadcast(?:s|ing)?|commercials?)\b/i,
  NA: /\b(?:canad(?:a|ian)|north america(?:n)?|mexic(?:o|an))\b/i,
  WORLD: /\b(?:world[- ]?wide|global(?:ly)?|international(?:ly)?|europe(?:an)?|u\.?k\.?|united kingdom|britain|australia(?:n)?|apac|asia[- ]pacific|latam|latin america(?:n)?|emea)\b/i,
  '12mo': /\b(?:(?:12|twelve)[- ]months?|(?:a|one|1)(?: full)? year|annual(?:ly)?|yearly)\b/i,
  exclusive: /\bexclusiv(?:e|ely|ity)\b/i,
  US: null,
  '6mo': null,
};

/** True when the sentence names the option (or the option needs no anchor). */
export function quoteSupports(optionId: string, sentence: string): boolean {
  const anchor = ANCHORS[optionId];
  return anchor === null || (anchor !== undefined && anchor.test(sentence));
}

// ---- tripwires (fix 2) ----

type Cover = { kind: 'channel'; channel: Channel } | { kind: 'territory'; min: Territory } | { kind: 'duration'; min: DurationMonths } | { kind: 'exclusive' } | { kind: 'never' };

export const TRIPWIRES: { word: string; pattern: RegExp; cover: Cover }[] = [
  { word: 'print', pattern: /\bprint(?:s|ed|ing)?\b/i, cover: { kind: 'channel', channel: 'print' } },
  { word: 'poster', pattern: /\bposters?\b/i, cover: { kind: 'channel', channel: 'print' } },
  { word: 'billboard', pattern: /\bbillboards?\b/i, cover: { kind: 'channel', channel: 'billboard' } },
  { word: 'OOH', pattern: /\booh\b/i, cover: { kind: 'channel', channel: 'OOH' } },
  { word: 'out-of-home', pattern: /\bout[- ]of[- ]home\b/i, cover: { kind: 'channel', channel: 'OOH' } },
  { word: 'TV', pattern: /\b(?:tv|television)\b/i, cover: { kind: 'channel', channel: 'TV' } },
  { word: 'broadcast', pattern: /\bbroadcast(?:s|ing)?\b/i, cover: { kind: 'channel', channel: 'TV' } },
  { word: 'worldwide', pattern: /\bworld[- ]?wide\b/i, cover: { kind: 'territory', min: 'WORLD' } },
  { word: 'global', pattern: /\bglobal(?:ly)?\b/i, cover: { kind: 'territory', min: 'WORLD' } },
  { word: 'international', pattern: /\binternational(?:ly)?\b/i, cover: { kind: 'territory', min: 'WORLD' } },
  { word: 'Europe', pattern: /\beurope(?:an)?\b/i, cover: { kind: 'territory', min: 'WORLD' } },
  { word: 'Canada', pattern: /\bcanad(?:a|ian)\b/i, cover: { kind: 'territory', min: 'NA' } },
  // fix 16: more territories outside North America
  { word: 'UK', pattern: /\bu\.k\.|\buk\b|\bunited kingdom\b|\bbritain\b/i, cover: { kind: 'territory', min: 'WORLD' } },
  { word: 'Australia', pattern: /\baustralia(?:n)?\b/i, cover: { kind: 'territory', min: 'WORLD' } },
  { word: 'APAC', pattern: /\bapac\b|\basia[- ]pacific\b/i, cover: { kind: 'territory', min: 'WORLD' } },
  { word: 'LatAm', pattern: /\blatam\b|\blatin america(?:n)?\b/i, cover: { kind: 'territory', min: 'WORLD' } },
  { word: 'EMEA', pattern: /\bemea\b/i, cover: { kind: 'territory', min: 'WORLD' } },
  { word: '12 months', pattern: /\b(?:12|twelve) months?\b/i, cover: { kind: 'duration', min: 12 } },
  { word: 'a year', pattern: /\b(?:a|one|1) (?:full )?year\b/i, cover: { kind: 'duration', min: 12 } },
  { word: 'exclusive', pattern: /\bexclusive(?:ly)?\b/i, cover: { kind: 'exclusive' } },
  { word: 'exclusivity', pattern: /\bexclusivity\b/i, cover: { kind: 'exclusive' } },
  { word: 'perpetual', pattern: /\bperpetu(?:al|ally|ity)\b/i, cover: { kind: 'never' } },
  { word: 'forever', pattern: /\bforever\b/i, cover: { kind: 'never' } },
  // fix 16: always the creator's call (which country? longer than any card term?)
  { word: 'national', pattern: /\bnation(?:al|ally|wide)\b/i, cover: { kind: 'never' } },
  { word: '2 years', pattern: /\b(?:[2-9]|\d{2,}|two|three|four|five|several|multiple) (?:full )?years?\b/i, cover: { kind: 'never' } },
  { word: 'multi-year', pattern: /\bmulti[- ]?years?\b/i, cover: { kind: 'never' } },
  { word: 'indefinite', pattern: /\bindefinite(?:ly)?\b/i, cover: { kind: 'never' } },
  { word: 'unlimited', pattern: /\bunlimited\b/i, cover: { kind: 'never' } },
  // B9 9.3, B11 item 1: paid promotion has no rate-card line. Add a paid term in reasons.ts, the one place that classifies it.
  ...PAID_PROMO_TRIPWIRES.map((t) => ({ ...t, cover: { kind: 'never' as const } })),
];

// §3.3 + fix 17. "not needed" is covered by "not".
const NEGATION = /\b(?:not|no|never|without|won['\u2019]?t|will not|skip(?:ping)?|scratch|drop(?:ping)?|exclud(?:e|ing)|pass on|hold off)\b/i;

function covered(cover: Cover, scope: Scope | null): boolean {
  if (!scope) return false;
  switch (cover.kind) {
    case 'channel':
      return scope.channels.includes(cover.channel);
    case 'territory':
      return TERRITORIES.indexOf(scope.territory) >= TERRITORIES.indexOf(cover.min);
    case 'duration':
      return scope.durationMonths >= cover.min;
    case 'exclusive':
      return scope.exclusive;
    case 'never':
      return false;
  }
}

/** Tripwire words found in client lines, in table order, deduplicated. */
export function tripwireHits(transcript: Transcript): { word: string; cover: Cover; lineIndex: number }[] {
  const hits: { word: string; cover: Cover; lineIndex: number }[] = [];
  for (const [i, line] of transcript.lines.entries()) {
    if (line.speaker !== 'client') continue;
    for (const t of TRIPWIRES) {
      if (t.pattern.test(line.text) && !hits.some((h) => h.word === t.word)) hits.push({ word: t.word, cover: t.cover, lineIndex: i });
    }
  }
  return hits;
}

// ---- main ----

export type CheckInput = {
  transcript: Transcript;
  extraction: Extraction;
  /** Scope of the client's active licence for this asset; null for a v1. */
  current: Scope | null;
  /**
   * True for a creator edit (model `creator_edit`): she has read the text herself, so tripwire and negation
   * findings become notes instead of blocking reasons. quote_missing, unknown_option and scope_unstated still block.
   */
  reviewedByCreator?: boolean;
};

/** Reason prefixes a creator's own review turns into notes (batch-4 review fix, review). */
export const REVIEWABLE_PREFIXES = ['tripwire', 'negation'] as const;

export function runChecks({ transcript, extraction, current, reviewedByCreator = false }: CheckInput): CheckResult {
  const blocking: string[] = [];
  const notes: string[] = [];
  const add = (r: string) => {
    const reviewable = (REVIEWABLE_PREFIXES as readonly string[]).includes(r.split(':')[0]!) && !isPaidPromoReason(r);
    const list = reviewedByCreator && reviewable ? notes : blocking;
    if (!list.includes(r)) list.push(r);
  };
  const kept: KeptUse[] = [];
  const dropped: DroppedUse[] = [];

  // 1. Quote rule (fix 9) and unknown option ids (§2).
  for (const use of extraction.uses) {
    if (!OPTION_IDS.includes(use.optionId)) {
      dropped.push({ ...use, reason: `unknown_option:${use.optionId}` });
      add(`unknown_option:${use.optionId}`);
      continue;
    }
    const found = findQuote(transcript, use.quote);
    if (!found) {
      dropped.push({ ...use, reason: `quote_missing:${use.optionId}` });
      add(`quote_missing:${use.optionId}`);
      continue;
    }
    // review P2: the sentence must actually name the option (e.g. "we love the colours" cannot back print).
    if (!quoteSupports(use.optionId, found.sentence)) {
      dropped.push({ ...use, reason: `quote_unrelated:${use.optionId}` });
      add(`quote_unrelated:${use.optionId}`);
      continue;
    }
    if (!kept.some((k) => k.optionId === use.optionId)) kept.push({ ...use, ...found });
  }

  // 2. Build requested from kept uses (fixes 6, 10).
  const keptIds = new Set(kept.map((k) => k.optionId));
  const channels = CHANNELS.filter((c) => keptIds.has(c));
  const territories = TERRITORIES.filter((t) => keptIds.has(t));
  const durations = DURATIONS.filter((d) => keptIds.has(`${d}mo`));
  let requested: Scope | null = null;
  if (channels.length > 0) {
    const territory = territories.at(-1) ?? current?.territory;
    const durationMonths = durations.at(-1) ?? current?.durationMonths;
    if (!territory) add('scope_unstated:territory');
    if (!durationMonths) add('scope_unstated:duration');
    if (territory && durationMonths) requested = { channels, territory, durationMonths, exclusive: keptIds.has('exclusive') };
  }

  // 3. Tripwires against requested combined with the current licence (fix 2), and negation (§3.3).
  const effective = requested && current ? combine(current, requested) : (requested ?? current);
  const hits = tripwireHits(transcript);
  for (const h of hits) {
    if (!covered(h.cover, effective)) add(`tripwire:${h.word}`);
  }
  const negated = transcript.lines.some(
    (l) => l.speaker === 'client' && NEGATION.test(l.text) && TRIPWIRES.some((t) => t.pattern.test(l.text)),
  );
  if (negated) add('negation');

  // 4. Status. Blocking reasons win; otherwise ambiguity -> clarify.
  const clarifyingQuestion = extraction.clarifyingQuestion?.trim() || null;
  if (blocking.length > 0) {
    return { status: 'needs_creator', requested, reasons: blocking, notes, kept, dropped, clarifyingQuestion };
  }
  const clarify: string[] = [];
  if (clarifyingQuestion) clarify.push('clarify:model_question');
  if (kept.length === 0) clarify.push('clarify:no_uses');
  else if (channels.length === 0) clarify.push('clarify:no_channel');
  if (clarify.length > 0) return { status: 'clarify', requested, reasons: clarify, notes, kept, dropped, clarifyingQuestion };
  return { status: 'ready', requested, reasons: [], notes, kept, dropped, clarifyingQuestion: null };
}
