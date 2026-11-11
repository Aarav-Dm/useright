'use client';
// B16: how licensing works as the same four steps the pay page and the receipt show, in plain words, followed by a
// short FAQ. Every answer describes what the app really does (rate-card prices, review before any invoice, PayPal
// confirms before the file unlocks, a checkable receipt). No icon cards, no drawn line: the order carries it.
import { JOURNEY } from './journey';
import { Reveal } from './reveal';

const BODY: Record<(typeof JOURNEY)[number], string> = {
  'Pick a photo': 'Browse the work and open any frame to see what each kind of use costs on the rate card.',
  'Ask for a licence': 'Say where, how and for how long you will use it. Sending a request costs nothing; the photographer reviews it before any invoice goes out.',
  'Pay with PayPal': 'You get a PayPal invoice priced from the rate card, never a guess. You pay on PayPal.',
  'Receipt and file': 'When PayPal confirms the payment, the file unlocks with a rights receipt of exactly what you licensed.',
};

const FAQ = [
  { q: 'Does sending a request charge me?', a: 'No. A request only asks. The photographer reviews it, and you pay only if you choose to pay the PayPal invoice that follows.' },
  { q: 'Where does the price come from?', a: 'From the rate card on this page, for the uses you ask for. If you already hold a licence on the photo, you pay only for the new use.' },
  { q: 'When do I get the file?', a: 'As soon as PayPal confirms your payment. The pay page checks with PayPal and unlocks the download; nothing unlocks before that.' },
  { q: 'What proves my licence?', a: 'A rights receipt naming the photo, the uses, the term and the file’s SHA-256 fingerprint. Anyone with its link can check it. It records payment and scope; it is not legal advice.' },
  { q: 'Can I use a photo in paid ads?', a: 'Paid promotion is not on this rate card. Mention it in your request and the photographer will answer you directly.' },
] as const;

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="mx-auto grid max-w-[1200px] scroll-mt-24 gap-16 px-4 py-28 sm:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div>
        <h2 id="how-title" className="g-display mb-10 text-5xl sm:text-6xl"><Reveal as="span" words>How licensing works</Reveal></h2>
        <ol className="grid gap-8">
          {JOURNEY.map((s, i) => (
            <Reveal as="li" key={s} delay={i * 0.06} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
              <span aria-hidden="true" className="g-display text-3xl leading-none text-[var(--g-accent)]">{i + 1}</span>
              <div>
                <h3 className="mb-1 text-lg font-medium">{s}</h3>
                <p className="text-[15px] leading-relaxed g-muted">{BODY[s]}</p>
              </div>
            </Reveal>
          ))}
        </ol>
      </div>
      <div>
        <h2 id="faq-title" className="mb-6 text-xl font-medium">Questions clients ask</h2>
        <div className="divide-y divide-white/10 border-y border-white/10" aria-labelledby="faq-title" role="group">
          {FAQ.map((f) => (
            <details key={f.q} className="group py-1">
              <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-3 text-[16px] font-medium [&::-webkit-details-marker]:hidden">
                {f.q}
                <span aria-hidden="true" className="text-xl leading-none g-muted transition-transform duration-200 group-open:rotate-45">+</span>
              </summary>
              <p className="max-w-[60ch] pb-4 text-[15px] leading-relaxed g-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
