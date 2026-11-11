'use client';
// Enter-once reveals: fade + 14px rise (ease-out, 600ms), or word by word (40ms stagger). CountUp eases a number up
// over 1.2s when it scrolls into view. Reduced motion: plain 150ms fade, numbers shown final.
import { animate, motion, useInView } from 'motion/react';
import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';
import { useReduce } from './motion-pref';

const EASE = [0.23, 1, 0.32, 1] as const;

type RevealProps = {
  as?: 'div' | 'p' | 'span' | 'h2' | 'h3' | 'li';
  className?: string;
  delay?: number;
  words?: boolean;
  children: ReactNode;
};

export function Reveal({ as = 'div', className, delay = 0, words, children }: RevealProps) {
  const reduce = useReduce();
  const Tag = motion[as] as ElementType;
  if (words && typeof children === 'string') {
    return (
      <Tag className={className} initial="hidden" whileInView="shown" viewport={{ once: true, margin: '-60px' }}
        transition={{ staggerChildren: reduce ? 0 : 0.04, delayChildren: delay }}>
        {children.split(' ').map((w, i) => (
          <motion.span key={i} className="inline-block whitespace-pre"
            variants={{
              hidden: reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(0.35em)', filter: 'blur(6px)' },
              // shown always resets transform and filter: SSR renders the full hidden state before useReduce flips to true
              shown: { opacity: 1, transform: 'translateY(0em)', filter: 'blur(0px)' },
            }}
            transition={{ duration: reduce ? 0.15 : 0.7, ease: EASE }}>
            {w}{' '}
          </motion.span>
        ))}
      </Tag>
    );
  }
  return (
    <Tag className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(14px)' }}
      whileInView={{ opacity: 1, transform: 'translateY(0px)' }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: reduce ? 0.15 : 0.6, ease: EASE, delay: reduce ? 0 : delay }}>
      {children}
    </Tag>
  );
}

export function CountUp({ to, format = (n: number) => Math.round(n).toLocaleString('en-US') }: { to: number; format?: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReduce();
  const [value, setValue] = useState(0); // same on server and first client render
  useEffect(() => {
    if (reduce) { setValue(to); return; }
    if (!inView) return;
    const c = animate(0, to, { duration: 1.2, ease: EASE, onUpdate: setValue });
    return () => c.stop();
  }, [inView, reduce, to]);
  return <span ref={ref}>{format(value)}</span>;
}
