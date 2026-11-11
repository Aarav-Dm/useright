'use client';
// Motion preferences that hydrate cleanly. useReduce is false on the server and during hydration, then follows the OS
// setting (motion's useReducedMotion is null on the server and true on the first client render, which mismatched).
// Pause is the visible "stop motion" toggle (WCAG 2.2.2): it stops auto motion; scroll-driven motion stays.
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';
const subscribeReduce = (cb: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener?.('change', cb);
  return () => m.removeEventListener?.('change', cb);
};
export const useReduce = () => useSyncExternalStore(subscribeReduce, () => window.matchMedia(QUERY).matches, () => false);

let paused = false;
const listeners = new Set<() => void>();
export const isPaused = () => paused;
export function setPaused(v: boolean) { paused = v; listeners.forEach((l) => l()); }
const subscribePaused = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const usePaused = () => useSyncExternalStore(subscribePaused, isPaused, () => false);
