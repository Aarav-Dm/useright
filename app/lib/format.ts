// Display helpers shared by the creator screens.
export const usd = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** A licence gets its renewal this long before its end (the tick's window). Here so screens can show the day. */
export const RENEWAL_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Review fix 9 (review 7): the day the renewal invoice goes out, a week before the licence ends. */
export const renewalInvoiceDay = (end: string | Date) => new Date(new Date(end).getTime() - RENEWAL_WINDOW_MS);
/** B9 9.4: how long a deal has waited, in plain words. */
export function waitingAge(since: string | Date, now: number = Date.now()): string {
  const hours = Math.max(0, Math.floor((now - new Date(since).getTime()) / 3_600_000));
  if (hours < 1) return 'Waiting under an hour';
  if (hours < 24) return `Waiting ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `Waiting ${days} ${days === 1 ? 'day' : 'days'}`;
}

export const shortDate = (d: string | Date | null, timeZone?: string) =>
  d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone }) : '—';

/** "Oct 29, 8:00 AM": date and time for event rows. */
export const shortDateTime = (d: string | Date) =>
  new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Where a request came from, as a short label. */
export const SOURCE_LABEL: Record<string, string> = { paste: 'Pasted text', screenshot: 'Screenshot', portfolio: 'Portfolio form', form: 'Form', renewal: 'Renewal (opened by the agent)' };

// Status words per docs/ui/deals.md (batch 7). Badges add an icon; the words alone must carry the meaning.
export const STATUS_LABEL: Record<string, string> = {
  ready: 'Ready',
  needs_creator: 'Needs you',
  clarify: 'Ask the client first',
  awaiting_verification: 'Waiting for email confirmation',
  awaiting_transcript: 'Confirm transcript',
  needs_approval: 'Needs your approval',
  sending: 'Sending invoice…',
  invoiced: 'Invoice sent',
  failed: 'Invoice send failed',
  cancelled: 'Invoice cancelled',
  rejected: 'Rejected',
  paid: 'Paid, file unlocked',
  refunded: 'Refunded, downloads stopped',
  expired: 'Expired, downloads stopped',
};

export const OPTION_LABEL: Record<string, string> = {
  social: 'Social', web: 'Web', print: 'Print', billboard: 'Billboard', OOH: 'Out-of-home', TV: 'TV',
  US: 'United States', NA: 'North America', WORLD: 'Worldwide', '6mo': '6 months', '12mo': '12 months',
  exclusive: 'Exclusive', 'credit:paid': 'Already paid',
};
export const optionLabel = (id: string) => OPTION_LABEL[id] ?? id;


const SHORT: Record<string, string> = { US: 'US', NA: 'North America', WORLD: 'Worldwide', '6mo': '6 mo', '12mo': '12 mo', exclusive: 'Exclusive' };

/**
 * A scope as display parts in a fixed order: channels, territory, term, exclusive. Each part keeps its option id
 * so the screen can mark the ones the read model lists in newOptionIds. Pure formatting; no pricing logic.
 */
export function scopeParts(scope: { channels: string[]; territory: string; durationMonths: number; exclusive: boolean }) {
  const ids = [...scope.channels, scope.territory, `${scope.durationMonths}mo`, ...(scope.exclusive ? ['exclusive'] : [])];
  return ids.map((id) => ({ id, label: SHORT[id] ?? optionLabel(id) }));
}
