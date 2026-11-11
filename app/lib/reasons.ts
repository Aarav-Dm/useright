// Plain-word sentence for every check reason (batch-4 §3, §6 fix 6). Reused by the ledger later.
// A reason is `prefix` or `prefix:suffix`; the sentence's {x} is filled with the suffix.

export const REASON_SENTENCES = {
  unknown_sender: 'The sender is not one of your clients, so the request is not tied to anyone yet.',
  ai_invalid: 'The AI reply could not be read twice in a row; nothing was extracted.',
  quote_missing: 'The AI listed "{x}" but its quote is not a whole sentence the client wrote, so it was dropped.',
  quote_unrelated: 'The AI listed "{x}" but the sentence it quoted does not mention it, so it was dropped.',
  unknown_option: 'The AI returned "{x}", which is not an option on your rate card, so it was dropped.',
  tripwire: 'The client mentioned "{x}", but no requested use covers it.',
  negation: 'The client said not to do something (for example "not in print"); check the scope by hand.',
  scope_unstated: 'This is a first licence and the client did not say the {x}.',
  clarify: 'The request is unclear: {x}.',
  // Deal states with no price yet (batch-4 review fix, review).
  awaiting_verification: 'Waiting for the requester to confirm their email. Nothing is read or priced until they do.',
  confirmed_on_page: 'Confirmed on the page, not by email. This request needs your approval.',
  awaiting_transcript: 'Check who said what in the transcript and confirm it; the request is read after that.',
  transcript_empty: 'The screenshot could not be read. Type the client\'s message in by hand, then confirm.',
  no_extraction: 'This request has not been read yet. Confirm the transcript again to read it.',
  // Batch 5: policy rules and the send lifecycle. {usd1}/{usd2} = colon parts as dollars, {1} = raw part.
  client_not_allowed: 'This client is not on your list of clients the agent may invoice.',
  over_deal_cap: '{usd1} exceeds your {usd2} per-deal cap.',
  daily_max_reached: 'The agent already sent {1} invoices today, your daily maximum.',
  rolling_cap_reached: 'This would bring the client to {usd1} in 30 days, over your {usd2} cap.',
  needs_approval: '{label1} needs your approval.',
  checks_not_clear: 'The request checks are not all clear.',
  amount_too_small: '{usd1} is below PayPal\'s $1.00 minimum for an invoice.',
  missing_client_email: 'The client has no valid email address to send the invoice to.',
  send_failed: 'The invoice could not be sent. See the error below and retry.',
  invoice_cancelled: 'The invoice was cancelled. Edit the deal to make a new quote.',
  rejected: 'You rejected this deal.',
  // Batch 6
  refunded: 'The payment was refunded or reversed in PayPal. The licence is revoked and downloads are stopped.',
  expired: 'The licence term ended without a paid renewal. Downloads are stopped.',
} as const satisfies Record<string, string>;

export type ReasonPrefix = keyof typeof REASON_SENTENCES;

/**
 * B11 item 1: paid promotion has no line on the rate card, so a request naming it cannot be priced or sold. Unlike other
 * tripwires a creator edit does not clear these, and no quote is made. A false match ("boost sales") is re-entered as a new request.
 */
export const PAID_PROMO_TRIPWIRES: { word: string; pattern: RegExp }[] = [
  { word: 'boost', pattern: /\bboost(?:s|ed|ing)?\b/i },
  { word: 'whitelisting', pattern: /\b(?:white|allow)[- ]?list(?:s|ed|ing)?\b/i },
  { word: 'paid ads', pattern: /\bpaid[- ](?:ads?|advertising|social|media)\b/i },
  { word: 'Spark Ads', pattern: /\bspark ads?\b/i },
];
export const PAID_USE_REFUSAL = 'Not on your rate card. Reject, or add a new request without paid use.';
export const isPaidPromoReason = (r: string) => r.startsWith('tripwire:') && PAID_PROMO_TRIPWIRES.some((t) => t.word === r.slice('tripwire:'.length));
export const hasPaidUse = (reasons: readonly string[] | null | undefined) => !!reasons?.some(isPaidPromoReason);

// Readable suffixes for codes whose suffix is an internal word.
const SUFFIX_WORDS: Record<string, string> = {
  model_question: 'the AI drafted a question for the client',
  no_uses: 'no use survived the checks',
  no_channel: 'no channel (social, web, print...) was named',
};

export function reasonPrefix(code: string): string {
  const i = code.indexOf(':');
  return i === -1 ? code : code.slice(0, i);
}

const PART_LABEL: Record<string, string> = { OOH: 'Out-of-home', TV: 'TV', exclusive: 'Exclusive rights' };
const dollars = (s: string | undefined) =>
  s && /^\d+$/.test(s) ? `$${(Number(s) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : (s ?? '');

/** One sentence for a reason code. Unknown codes are shown as-is so nothing is hidden. */
export function describeReason(code: string): string {
  const prefix = reasonPrefix(code);
  const template = (REASON_SENTENCES as Record<string, string>)[prefix];
  if (!template) return `Unrecognised check: ${code}`;
  const suffix = code.length > prefix.length ? code.slice(prefix.length + 1) : '';
  const parts = suffix.split(':');
  return template
    .replace('{x}', SUFFIX_WORDS[suffix] ?? suffix)
    .replace(/\{usd(\d)\}/g, (_m, i: string) => dollars(parts[Number(i) - 1]))
    .replace(/\{label(\d)\}/g, (_m, i: string) => {
      const p = parts[Number(i) - 1] ?? '';
      return PART_LABEL[p] ?? (p ? p[0]!.toUpperCase() + p.slice(1) : p);
    })
    .replace(/\{(\d)\}/g, (_m, i: string) => parts[Number(i) - 1] ?? '');
}
