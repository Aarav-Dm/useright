'use client';
// Magnetic button: the button drifts toward the cursor (0.25x the offset, max 8px) on a spring and settles back
// when the cursor leaves. Fine pointers only; off under reduced motion. Press, shine and arrow are CSS (glass.css).
import { motion, useMotionValue, useSpring } from 'motion/react';
import type { ComponentPropsWithoutRef, PointerEvent, ReactNode } from 'react';
import { useReduce } from './motion-pref';

const PULL = 0.25;
const MAX = 8;
const SPRING = { stiffness: 300, damping: 20, mass: 0.6 };

type Variant = 'primary' | 'ghost';

function useMagnet() {
  const reduce = useReduce();
  const x = useSpring(useMotionValue(0), SPRING);
  const y = useSpring(useMotionValue(0), SPRING);
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (reduce || e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    const clamp = (v: number) => Math.max(-MAX, Math.min(MAX, v));
    x.set(clamp((e.clientX - (r.left + r.width / 2)) * PULL));
    y.set(clamp((e.clientY - (r.top + r.height / 2)) * PULL));
  };
  const onPointerLeave = () => { x.set(0); y.set(0); };
  return { style: { x, y }, onPointerMove, onPointerLeave };
}

export function Arrow() {
  return (
    <svg className="g-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type ButtonProps = Omit<ComponentPropsWithoutRef<'button'>, 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart'> & {
  variant?: Variant;
  size?: 'md' | 'sm';
  arrow?: boolean;
  children: ReactNode;
};

export function MagneticButton({ variant = 'primary', size = 'md', arrow, className = '', children, ...rest }: ButtonProps) {
  const m = useMagnet();
  return (
    <motion.button
      type="button"
      {...rest}
      style={m.style}
      onPointerMove={m.onPointerMove}
      onPointerLeave={m.onPointerLeave}
      className={`g-btn g-btn-${variant} ${size === 'sm' ? 'g-btn-sm' : ''} ${className}`}
    >
      {children}
      {arrow && <Arrow />}
    </motion.button>
  );
}

type LinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart'> & {
  variant?: Variant;
  size?: 'md' | 'sm';
  arrow?: boolean;
  children: ReactNode;
};

export function MagneticLink({ variant = 'primary', size = 'md', arrow, className = '', children, ...rest }: LinkProps) {
  const m = useMagnet();
  return (
    <motion.a
      {...rest}
      style={m.style}
      onPointerMove={m.onPointerMove}
      onPointerLeave={m.onPointerLeave}
      className={`g-btn g-btn-${variant} ${size === 'sm' ? 'g-btn-sm' : ''} ${className}`}
    >
      {children}
      {arrow && <Arrow />}
    </motion.a>
  );
}
