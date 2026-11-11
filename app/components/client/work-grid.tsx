'use client';
// Masonry of the portfolio. Filter chips with a sliding pill; tiles tilt toward the cursor (max 8deg, spring) with a
// glare that follows it; caption slides up on hover or focus. A tile shares its layoutId with the detail view so
// clicking morphs it open. Spec §4.3.
import Image from 'next/image';
import { AnimatePresence, LayoutGroup, motion, useMotionValue, useSpring } from 'motion/react';
import { useState, type PointerEvent } from 'react';
import { Reveal } from './reveal';
import type { PortfolioPhoto } from './types';
import { useReduce } from './motion-pref';

type Filter = 'all' | 'landscape' | 'portrait';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'landscape', label: 'Landscape' },
  { id: 'portrait', label: 'Portrait' },
];
const TILT = 8;
const SPRING = { stiffness: 220, damping: 18 };

function Tile({ photo, index, onOpen, hidden }: { photo: PortfolioPhoto; index: number; onOpen: (i: number) => void; hidden: boolean }) {
  const reduce = useReduce();
  const rx = useSpring(useMotionValue(0), SPRING);
  const ry = useSpring(useMotionValue(0), SPRING);
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (reduce || e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    ry.set((px - 0.5) * 2 * TILT);
    rx.set(-(py - 0.5) * 2 * TILT);
    e.currentTarget.style.setProperty('--gx', `${px * 100}%`);
    e.currentTarget.style.setProperty('--gy', `${py * 100}%`);
  };
  const onLeave = () => { rx.set(0); ry.set(0); };
  return (
    <motion.li layout={!reduce} className="mb-4 break-inside-avoid"
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(24px)' }}
      whileInView={reduce ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0px)' }}
      viewport={{ once: true, margin: '-40px' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={{ duration: reduce ? 0.15 : 0.6, ease: [0.23, 1, 0.32, 1], delay: reduce ? 0 : (index % 3) * 0.06 }}
      style={{ perspective: 900 }}>
      <motion.button type="button" className="g-tile" onClick={() => onOpen(index)} onPointerMove={onMove} onPointerLeave={onLeave}
        style={{ rotateX: rx, rotateY: ry, visibility: hidden ? 'hidden' : 'visible' }}
        aria-label={`Open ${photo.title}`}>
        <motion.div layoutId={reduce ? undefined : `photo-${photo.num}`} className="overflow-hidden rounded-[16px]">
          <Image src={photo.src} alt={photo.alt} width={photo.width} height={photo.height}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 400px" quality={75}
            placeholder={photo.blurDataUrl ? 'blur' : 'empty'} blurDataURL={photo.blurDataUrl} />
        </motion.div>
        <span className="g-tile-glare" aria-hidden="true" />
        <span className="g-tile-caption flex items-end justify-between text-left">
          <span>
            <span className="block text-[15px] font-medium text-white">{photo.title}</span>
            <span className="g-mono block text-[11px] uppercase tracking-[0.12em] g-muted">No. {photo.num} · {photo.orientation}</span>
          </span>
          <span className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] text-white backdrop-blur">View</span>
        </span>
      </motion.button>
    </motion.li>
  );
}

export function WorkGrid({ photos, onOpen, openIndex }: { photos: PortfolioPhoto[]; onOpen: (i: number) => void; openIndex: number | null }) {
  const [filter, setFilter] = useState<Filter>('all');
  const shown = photos.map((p, i) => ({ p, i })).filter(({ p }) => filter === 'all' || p.orientation === filter);
  return (
    <section id="work" aria-labelledby="work-title" className="relative mx-auto max-w-[1200px] scroll-mt-24 px-4 py-28 sm:px-8">
      <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
        <div>
          <Reveal as="p" className="g-mono mb-3 text-xs uppercase tracking-[0.14em] text-[var(--g-accent)]">Portfolio</Reveal>
          <h2 id="work-title" className="g-display text-5xl sm:text-6xl"><Reveal as="span" words>The work, <em>ready to license</em></Reveal></h2>
        </div>
        <LayoutGroup id="filters">
          <div role="group" aria-label="Filter photos" className="g-card flex gap-1 rounded-full p-1">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className="g-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {filter === f.id && <motion.span layoutId="filter-pill" className="g-chip-pill" transition={{ type: 'spring', duration: 0.35, bounce: 0.15 }} />}
                {f.label}
              </button>
            ))}
          </div>
        </LayoutGroup>
      </div>
      <ul className="columns-1 gap-4 sm:columns-2 lg:columns-3">
        <AnimatePresence mode="popLayout">
          {shown.map(({ p, i }) => <Tile key={p.num} photo={p} index={i} onOpen={onOpen} hidden={openIndex === i} />)}
        </AnimatePresence>
      </ul>
    </section>
  );
}
