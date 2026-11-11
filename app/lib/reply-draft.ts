// Batch 12 Part B items 1 and 2: the reply the creator may copy to the client. Built by code from the stored deal view
// (the client sentences the checks kept, the gap() price lines, the pay link): no model call, and the app sends nothing.
import type { BriefView } from './briefs';
import { optionLabel, usd } from './format';
import { hasPaidUse, isPaidPromoReason } from './reasons';

/** Deal states where a priced reply makes sense: before the send, while the invoice is out, and once paid. */
const PRICED = new Set(['ready', 'needs_creator', 'needs_approval', 'sending', 'invoiced', 'paid']);

export function replyDraft(view: BriefView): string | null {
  if (view.brief.source === 'renewal' || view.version?.invoice?.demo) return null;
  const hi = view.client ? `Hi ${view.client.name},` : 'Hi,';
  const about = view.asset ? `Thanks for your message about "${view.asset.title}".` : 'Thanks for your message.';
  // Client evidence stays intact; a copied reply must not carry an old or client-supplied payment link.
  const sentences = [...new Set(view.checks?.kept.map((k) => k.sentence) ?? [])]
    .filter((s) => !/(?:https?:\/\/|www\.|\/pay\/|\b[\w-]+(?:\.[\w-]+)+\/)/i.test(s));
  const asked = sentences.length ? ['You wrote:', ...sentences.map((s) => `- "${s}"`)] : [];

  // B11 rule: a paid-ads request shows no price anywhere, so this branch names uses only, never a figure.
  if (view.status === 'needs_creator' && hasPaidUse(view.reasons)) {
    const words = view.reasons.filter(isPaidPromoReason).map((r) => r.slice('tripwire:'.length));
    const req = view.checks?.requested;
    const uses = req ? [...req.channels, req.territory, `${req.durationMonths}mo`].map(optionLabel).join(', ') : null;
    return [
      hi, '', about, '',
      `Paid promotion (${words.join(', ')}) is not on my rate card, so I cannot price it from there.`,
      uses ? `What my rate card can license for this photo: ${uses}, without paid promotion.` : 'My rate card can license it for organic use, such as social, web or print.',
      'If that works for you, send me a request for that use and I will quote it.',
      '', 'Thanks,',
    ].join('\n');
  }

  const g = view.gapPreview;
  if (!g || g.refused || !PRICED.has(view.status)) return null;
  const inv = view.version?.invoice;
  const link = inv && !inv.demo ? inv.payUrl : null;
  const next = view.status === 'paid'
    ? (link ? `PayPal confirmed your payment. Your file and rights receipt are here: ${link}` : 'PayPal confirmed your payment.')
    : view.status === 'invoiced' && link
      ? `You can pay here; the file unlocks as soon as PayPal confirms payment: ${link}`
      : 'A PayPal invoice for this amount follows. The file unlocks as soon as PayPal confirms payment.';
  return [
    hi, '', about, ...asked, '',
    'From my rate card:',
    ...g.lines.map((l) => `- ${optionLabel(l.optionId)}: ${usd(l.cents)}`),
    `Total: ${usd(g.totalCents)}`,
    '', next, '', 'Thanks,',
  ].join('\n');
}
