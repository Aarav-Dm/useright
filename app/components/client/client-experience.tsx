'use client';
// Public creator page (/c/[slug]): glass nav, globe hero, work grid, how it works, rate card, about, closing call to
// action. Owns which photo is open and whether the request drawer is open. Spec:
// docs/superpowers/specs/2026-11-02-client-experience-design.md.
import Image from 'next/image';
import { MotionConfig, motion, useMotionValueEvent, useScroll } from 'motion/react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { GlobeHero } from './globe-hero';
import { HowItWorks } from './how-it-works';
import { MagneticButton } from './magnetic';
import { PhotoDetail } from './photo-detail';
import { Pricing } from './pricing';
import { RequestDrawer } from './request-drawer';
import { Reveal } from './reveal';
import { setPaused, usePaused } from './motion-pref';
import { WorkGrid } from './work-grid';
import type { PortfolioPhoto, PublicCreator } from './types';
import './glass.css';

const LINKS = [
  { href: '#work', label: 'Work' },
  { href: '#how', label: 'How it works' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#about', label: 'About' },
];

function Nav({ name, onRequest }: { name: string; onRequest: () => void }) {
  const { scrollY } = useScroll();
  const [compact, setCompact] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  useMotionValueEvent(scrollY, 'change', (y) => setCompact(y > 80));
  return (
    <header className="fixed inset-x-0 top-3 z-[250] flex justify-center px-3">
      {/* One-off change at a scroll threshold, so a plain CSS transition; not a per-frame layout animation. */}
      <nav aria-label="Main" className={`g-card flex w-full items-center gap-2 !rounded-full py-1.5 pl-5 pr-1.5 transition-[max-width,background-color] duration-[350ms] ease-[cubic-bezier(0.23,1,0.32,1)] ${compact ? 'max-w-[720px] !bg-[rgba(13,13,16,0.78)]' : 'max-w-[1200px]'}`}>
        <a href="#top" className="g-display mr-auto text-2xl leading-none">{name.split(' ')[0]}<span className="text-[var(--g-accent)]">.</span></a>
        <ul className="hidden items-center md:flex" onPointerLeave={() => setHover(null)}>
          {LINKS.map((l) => (
            <li key={l.href} className="relative">
              {hover === l.href && <motion.span layoutId="nav-hover" className="absolute inset-0 rounded-full bg-white/10" transition={{ type: 'spring', duration: 0.3, bounce: 0.1 }} />}
              <a href={l.href} onPointerEnter={() => setHover(l.href)} className="relative block px-4 py-2 text-sm g-muted transition-colors hover:text-white">{l.label}</a>
            </li>
          ))}
        </ul>
        <MagneticButton size="sm" arrow onClick={onRequest}>Request a licence</MagneticButton>
      </nav>
    </header>
  );
}

export function ClientExperience({ creator, photos }: { creator: PublicCreator; photos: PortfolioPhoto[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [drawer, setDrawer] = useState<{ open: boolean; photo: PortfolioPhoto | null; draft?: string }>({ open: false, photo: null });
  const request = useCallback((photo: PortfolioPhoto | null = null) => { setOpenIndex(null); setDrawer({ open: true, photo }); }, []);
  const close = useCallback(() => setOpenIndex(null), []);
  const step = useCallback((d: 1 | -1) => setOpenIndex((i) => (i === null ? i : (i + d + photos.length) % photos.length)), [photos.length]);
  const closeDrawer = useCallback(() => setDrawer((s) => ({ ...s, open: false })), []);
  const about = photos[Math.min(5, photos.length - 1)];
  const paused = usePaused();

  // One place owns modal focus: remember what opened the first overlay, lock scroll and make the page inert while
  // any overlay is up, and hand focus back when the last one closes. Layout effect, so it reads the opener before
  // the dialog's own effect moves focus.
  const anyOpen = openIndex !== null || drawer.open;
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (anyOpen && !wasOpen.current) opener.current = document.activeElement as HTMLElement | null;
    if (!anyOpen && wasOpen.current) opener.current?.focus?.();
    wasOpen.current = anyOpen;
    document.body.style.overflow = anyOpen ? 'hidden' : '';
  }, [anyOpen]);
  useLayoutEffect(() => () => { document.body.style.overflow = ''; }, []); // leaving the page with a dialog open
  // Tab and Shift+Tab wrap inside the top-most open dialog.
  useLayoutEffect(() => {
    if (!anyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
      const top = dialogs[dialogs.length - 1];
      if (!top) return;
      const items = [...top.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.hasAttribute('disabled'));
      const first = items[0], last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !top.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [anyOpen]);

  return (
    <MotionConfig reducedMotion="user">
    <div id="top" className={`theme-glass${paused ? ' g-paused' : ''}`}>
      <div className="g-backdrop" aria-hidden="true"><div className="g-grain" /></div>
      <div inert={anyOpen}>
      <a href="#work" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[500] focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-black">Skip to the work</a>
      <Nav name={creator.name} onRequest={() => request()} />

      <main>
        <GlobeHero name={creator.name} photos={photos} onOpen={setOpenIndex} onRequest={() => request()}
          stats={[
            { value: photos.length, label: 'photos to license' },
            { value: 6, label: 'kinds of use' },
          ]} />
        <WorkGrid photos={photos} onOpen={setOpenIndex} openIndex={openIndex} />
        <HowItWorks />
        <Pricing card={creator.rateCard} onRequest={(draft) => { setOpenIndex(null); setDrawer({ open: true, photo: null, draft }); }} />

        <section id="about" aria-labelledby="about-title" className="mx-auto grid max-w-[1200px] scroll-mt-24 items-center gap-10 px-4 py-28 sm:px-8 lg:grid-cols-2">
          {about && (
            <Reveal className="relative aspect-[4/5] overflow-hidden rounded-[28px] border border-white/10">
              <Image src={about.src} alt={about.alt} fill sizes="(max-width: 1024px) 100vw, 560px" className="object-cover" quality={80}
                placeholder={about.blurDataUrl ? 'blur' : 'empty'} blurDataURL={about.blurDataUrl} />
            </Reveal>
          )}
          <div>
            <Reveal as="p" className="g-mono mb-3 text-xs uppercase tracking-[0.14em] text-[var(--g-accent)]">About</Reveal>
            <h2 id="about-title" className="g-display mb-6 text-5xl sm:text-6xl"><Reveal as="span" words>{`Hi, I'm ${creator.name.split(' ')[0]}.`}</Reveal></h2>
            <Reveal as="p" delay={0.1} className="mb-4 text-[17px] leading-relaxed g-muted">
              I photograph light, cities and the quiet in between, for brands that care how their pictures feel. Every
              frame here can be licensed for exactly the use you need, priced from my own rate card.
            </Reveal>
            <Reveal as="p" delay={0.15} className="mb-8 text-[17px] leading-relaxed g-muted">
              My agent reads your brief, prices it, and sends a PayPal invoice. When PayPal confirms, the file is yours
              with a receipt that proves what you bought.
            </Reveal>
            <Reveal delay={0.2} className="flex flex-wrap gap-3">
              <MagneticButton arrow onClick={() => request()}>Start a request</MagneticButton>
            </Reveal>
          </div>
        </section>

        <section className="mx-auto max-w-[1200px] px-4 pb-24 sm:px-8">
          <Reveal className="g-card relative overflow-hidden !rounded-[28px] px-6 py-16 text-center sm:px-16">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,rgba(255,236,210,0.14),transparent)]" aria-hidden="true" />
            <h2 className="g-display relative mx-auto max-w-[720px] text-5xl sm:text-7xl"><Reveal as="span" words>Found the one?</Reveal></h2>
            <p className="relative mx-auto mt-4 max-w-[460px] g-muted">Send a request in under a minute. The creator reviews it, then you get a quote and a PayPal invoice, and the file unlocks when PayPal confirms.</p>
            <div className="relative mt-8 flex justify-center"><MagneticButton arrow onClick={() => request()}>Request a licence</MagneticButton></div>
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm g-muted sm:px-8">
          <span>© {creator.name}. Payments by PayPal.</span>
          <a className="underline-offset-4 hover:text-white hover:underline" href="/credits">Photo credits</a>
        </div>
      </footer>
      <button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}
        className="g-btn g-btn-ghost g-btn-sm fixed bottom-4 left-4 z-[240]">
        {paused ? 'Play motion' : 'Pause motion'}
      </button>
      </div>

      <PhotoDetail photos={photos} index={openIndex} card={creator.rateCard} onClose={close} onStep={step} onRequest={(i) => request(photos[i])} />
      <RequestDrawer open={drawer.open} photo={drawer.photo} photos={photos} creatorSlug={creator.slug} creatorName={creator.name} draft={drawer.draft} onClose={closeDrawer} />
    </div>
    </MotionConfig>
  );
}
