'use client';
// Photo detail: the grid tile morphs (shared layoutId) into a centred glass panel with the photo, its title and the
// creator's real starting prices. Esc, the close button or a click on the backdrop closes it by morphing back;
// arrow keys step through photos; on touch, a downward drag closes it. Spec §4 "Photo detail".
import Image from 'next/image';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { usd } from '@/lib/format';
import { price, type Channel, type RateCard } from '@/lib/pricing';
import { MagneticButton } from './magnetic';
import type { PortfolioPhoto } from './types';
import { useReduce } from './motion-pref';

const SPRING = { type: 'spring' as const, stiffness: 380, damping: 32 };

export function PhotoDetail({ photos, index, card, onClose, onStep, onRequest }: {
  photos: PortfolioPhoto[];
  index: number | null;
  card: RateCard;
  onClose: () => void;
  onStep: (dir: 1 | -1) => void;
  onRequest: (i: number) => void;
}) {
  const reduce = useReduce();
  const closeRef = useRef<HTMLButtonElement>(null);
  const photo = index === null ? null : photos[index];

  useEffect(() => {
    if (index === null) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onStep(1);
      if (e.key === 'ArrowLeft') onStep(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey); // focus return and scroll lock: ClientExperience
  }, [index, onClose, onStep]);

  const from = (c: Channel) => price({ channels: [c], territory: 'US', durationMonths: 6, exclusive: false }, card).totalCents;
  const uses = [
    { label: 'Social', cents: from('social') },
    { label: 'Web', cents: from('web') },
    { label: 'Print', cents: from('print') },
    { label: 'Billboard', cents: from('billboard') },
  ];

  return (
    <AnimatePresence>
      {photo && index !== null && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-3 sm:p-8" role="dialog" aria-modal="true" aria-label={photo.title}>
          <motion.div className="absolute inset-0 bg-[#060607]/70" onClick={onClose}
            initial={{ opacity: 0, backdropFilter: 'blur(0px)' }} animate={{ opacity: 1, backdropFilter: 'blur(12px)' }}
            exit={{ opacity: 0, backdropFilter: 'blur(0px)', transition: { duration: 0.2 } }} transition={{ duration: 0.3 }} />
          <motion.div className="g-card relative grid max-h-full w-full max-w-[1080px] overflow-hidden lg:grid-cols-[1.4fr_1fr]"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}
            drag={reduce ? false : 'y'} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0.05, bottom: 0.6 }}
            onDragEnd={(_, info) => { if (info.offset.y > 120 || info.velocity.y > 600) onClose(); }}>
            <motion.div layoutId={reduce ? undefined : `photo-${photo.num}`} transition={SPRING} className="relative min-h-[260px] bg-black/40">
              <Image src={photo.src} alt={photo.alt} fill sizes="(max-width: 1024px) 100vw, 640px" quality={85}
                className="object-contain" placeholder={photo.blurDataUrl ? 'blur' : 'empty'} blurDataURL={photo.blurDataUrl} />
            </motion.div>
            <motion.div className="flex flex-col gap-6 overflow-y-auto p-6 sm:p-8"
              initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateX(16px)' }} animate={reduce ? { opacity: 1 } : { opacity: 1, transform: 'translateX(0px)' }}
              exit={{ opacity: 0 }} transition={{ duration: 0.35, delay: reduce ? 0 : 0.12, ease: [0.23, 1, 0.32, 1] }}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="g-mono text-[11px] uppercase tracking-[0.14em] g-muted">No. {photo.num} · {photo.orientation}</p>
                  <h2 className="g-display mt-2 text-4xl">{photo.title}</h2>
                </div>
                <button ref={closeRef} type="button" onClick={onClose} aria-label="Close"
                  className="g-btn g-btn-ghost g-btn-sm !h-10 !w-10 !p-0 shrink-0">
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                </button>
              </div>
              <p className="text-sm leading-relaxed g-muted">{photo.alt}</p>
              <div>
                <p className="mb-3 text-xs uppercase tracking-[0.12em] g-muted">From, US, 6 months</p>
                <ul className="grid grid-cols-2 gap-2">
                  {uses.map((u, i) => (
                    <motion.li key={u.label} className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5"
                      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(8px)' }} animate={reduce ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0px)' }}
                      transition={{ delay: reduce ? 0 : 0.18 + i * 0.05, duration: 0.3 }}>
                      <span className="block text-xs g-muted">{u.label}</span>
                      <span className="g-mono text-lg text-white">{usd(u.cents)}</span>
                    </motion.li>
                  ))}
                </ul>
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-3">
                <MagneticButton arrow onClick={() => onRequest(index)}>Request this photo</MagneticButton>
                <div className="flex gap-1">
                  <button type="button" className="g-btn g-btn-ghost g-btn-sm" onClick={() => onStep(-1)} aria-label="Previous photo">←</button>
                  <button type="button" className="g-btn g-btn-ghost g-btn-sm" onClick={() => onStep(1)} aria-label="Next photo">→</button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
