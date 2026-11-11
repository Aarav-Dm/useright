import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import '../client/glass.css';
import './landing.css';

const STEPS = [
  {
    who: 'You: paste the brief.',
    title: 'Bring the brief',
    body: 'Paste a client message or add a DM screenshot. The model reads the requested use and points to the words behind it.',
  },
  {
    who: 'The agent: prices and invoices.',
    title: 'Price from your rate card',
    body: 'Code prices the gap from the current licence. The agent invoices within your limits and brings other requests back to you.',
  },
  {
    who: 'PayPal: confirms the payment.',
    title: 'PayPal confirms. The file unlocks.',
    body: 'The client pays the invoice. UseRight checks with PayPal before releasing the file and a receipt of the licensed use.',
  },
];

export function Landing() {
  return (
    <div className="theme-glass landing">
      <a className="landing-skip" href="#main">Skip to content</a>
      <header className="landing-header">
        <Link className="landing-brand" href="/" aria-label="UseRight Agent home">UseRight<span aria-hidden="true">.</span></Link>
        <nav aria-label="Main"><Link href="/c/imani">Imani’s portfolio</Link><Link className="landing-nav-optional" href="#process">How it works</Link><Link href="/login">Creator sign in</Link></nav>
      </header>
      <main id="main" tabIndex={-1}>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div>
            <h1 id="landing-title" className="g-display">Your work.<br />Its next licence.</h1>
            <p className="landing-lead">Client briefs become PayPal invoices, priced from your rate card. The file unlocks only when PayPal confirms payment.</p>
            <div className="landing-actions">
              <Button asChild className="landing-primary" size="lg"><Link href="/c/imani">Explore Imani’s portfolio</Link></Button>
              <Button asChild className="landing-secondary" variant="ghost" size="lg"><Link href="/login">Sign in to your workspace</Link></Button>
            </div>
            {/* B16: one quiet sentence, not a white box on the dark hero (hallmark floor: no card for a sentence). */}
            <p className="landing-review" role="note">
              Reviewing this entry? Start with <Link href="/c/imani">Imani’s portfolio</Link>, or <Link href="/login">sign in with the demo login</Link>.
            </p>
          </div>
          <figure className="landing-photo">
            <div className="landing-photo-frame"><Image src="/portfolio/imani/11.jpg" alt="Coffee being poured from a moka pot into a cup" fill priority sizes="(min-width: 900px) 40vw, 90vw" /></div>
            <figcaption><span>Morning Pour</span><span className="g-mono">From Imani’s portfolio</span></figcaption>
          </figure>
        </section>
        <section id="process" className="landing-process scroll-mt-24" aria-labelledby="process-title">
          <div><h2 id="process-title" className="g-display">A clear path to the next use.</h2></div>
          <ol>
            {STEPS.map((step, index) => (
              <li key={step.title}>
                {index > 0 ? <Separator className="my-7" /> : null}
                <div className="flex gap-6">
                  <span className="g-mono landing-step" aria-hidden="true">0{index + 1}</span>
                  <div>
                    <p className="text-label">{step.who}</p>
                    <h3>{step.title}</h3>
                    <p>{step.body}</p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <footer className="landing-footer"><span>UseRight Agent</span><p>Receipts record payment and scope. They are not legal advice.</p></footer>
    </div>
  );
}
