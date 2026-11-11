'use client';
// Hero: a dotted WebGL earth (cobe) with 24 real <img> tiles orbiting just above it
// on a CSS 3D Fibonacci sphere. While the section is pinned, scrolling slows the spin and
// flies every tile (staggered from the centre out) into a mosaic grid. Transforms are written straight to each
// tile in one rAF loop (no React re-render per frame); the loop sleeps when the hero is off screen or the tab is
// hidden. Reduced motion: a still globe, no pin, no flight. Spec §4.2 and §6.
import createGlobe, { type Globe } from 'cobe';
import Image from 'next/image';
import { useEffect, useRef } from 'react';
import { MagneticButton, MagneticLink } from './magnetic';
import { Reveal, CountUp } from './reveal';
import type { PortfolioPhoto } from './types';
import { isPaused, usePaused, useReduce } from './motion-pref';

const SPIN_DEG_PER_S = 8;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

type Props = {
  name: string;
  photos: PortfolioPhoto[];
  stats: { value?: number; label: string; suffix?: string }[];
  onOpen: (index: number) => void;
  onRequest: () => void;
};

type Layout = {
  cellW: number; cellH: number;
  globe: { cx: number; cy: number; R: number; scale: number };
  grid: { x: number; y: number }[];
  delay: number[];
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function sphere(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = GOLDEN * i;
    return { x: Math.cos(t) * r, y, z: Math.sin(t) * r };
  });
}

function computeLayout(W: number, H: number, n: number): Layout {
  const wide = W >= 1024;
  const cols = wide ? 6 : W >= 640 ? 4 : 3;
  const rows = Math.ceil(n / cols);
  const pad = wide ? 32 : 16;
  const gap = wide ? 14 : 8;
  let cellW = (W - pad * 2 - gap * (cols - 1)) / cols;
  let cellH = cellW * 0.68;
  const maxH = (H - pad * 2 - 72 - gap * (rows - 1)) / rows; // 72: room for the nav
  if (cellH > maxH) { cellH = maxH; cellW = cellH / 0.68; }
  const gridW = cols * cellW + (cols - 1) * gap;
  const gridH = rows * cellH + (rows - 1) * gap;
  const ox = (W - gridW) / 2;
  const oy = 72 + (H - 72 - gridH) / 2;
  const grid = Array.from({ length: n }, (_, i) => ({ x: ox + (i % cols) * (cellW + gap), y: oy + Math.floor(i / cols) * (cellH + gap) }));
  // Stagger: tiles near the grid centre leave first.
  const mid = { x: W / 2, y: oy + gridH / 2 };
  const dist = grid.map((g) => Math.hypot(g.x + cellW / 2 - mid.x, g.y + cellH / 2 - mid.y));
  const maxD = Math.max(...dist) || 1;
  const R = wide ? Math.min(W * 0.21, H * 0.34) : Math.min(W * 0.34, H * 0.2);
  const globeTileW = R * 0.5;
  return {
    cellW, cellH, grid,
    delay: dist.map((d) => (d / maxD) * 0.35),
    globe: { cx: wide ? W * 0.7 : W / 2, cy: wide ? H * 0.52 : H * 0.74, R, scale: globeTileW / cellW },
  };
}

export function GlobeHero({ name, photos, stats, onOpen, onRequest }: Props) {
  const reduce = useReduce();
  const paused = usePaused();
  const wake = useRef<() => void>(() => {});
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const earthRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const progress = useRef(0);

  useEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    if (!section || !stage) return;
    const points = sphere(photos.length);
    let layout = computeLayout(stage.clientWidth, stage.clientHeight, photos.length);
    let angle = 20;
    let tilt = -12;
    let velocity = 0; // deg per frame, from drag
    let dragging = false;
    let pending: number | null = null, startX = 0, startY = 0;
    let lastX = 0;
    let lastY = 0;
    let last = performance.now();
    let raf = 0;
    let visible = true;
    const earthHost = earthRef.current;
    let earth: Globe | null = null;
    let earthSize = 0;
    let lastPhi = NaN, lastTheta = NaN;
    const EARTH = 2.05; // host = 2.05 R, so the dotted sphere sits just inside the photo orbit
    // Phones and weak GPUs: 1x pixels and fewer dots, the shader runs per pixel every frame.
    const light = window.innerWidth <= 640 || (navigator.hardwareConcurrency || 8) <= 4;
    const dpr = Math.min(light ? 1 : 2, window.devicePixelRatio || 1);
    const sizeEarth = () => {
      earthSize = Math.round(layout.globe.R * EARTH);
      const host = earthRef.current;
      if (host) host.style.width = host.style.height = `${earthSize}px`;
    };
    // Built once per effect (and after a lost GPU context). cobe wraps the canvas in its own div, so the canvas lives in
    // a host div React never renders children into. cobe scales width/height by devicePixelRatio itself.
    const makeEarth = () => {
      const host = earthRef.current;
      if (!host) return;
      earth?.destroy();
      host.replaceChildren();
      const canvas = document.createElement('canvas');
      canvas.style.width = canvas.style.height = '100%';
      canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
      canvas.addEventListener('webglcontextrestored', () => { makeEarth(); draw(); });
      host.append(canvas);
      sizeEarth();
      lastPhi = NaN;
      // Without WebGL cobe returns a no-op globe; the photo globe works on its own.
      earth = createGlobe(canvas, {
        devicePixelRatio: dpr, width: earthSize, height: earthSize,
        phi: 0, theta: 0.25, dark: 1, diffuse: 1.15, mapSamples: light ? 8000 : 18000, mapBrightness: 8, mapBaseBrightness: 0.02,
        baseColor: [0.16, 0.155, 0.15], markerColor: [0.9, 0.72, 0.45], glowColor: [0.22, 0.2, 0.18],
        opacity: 0.9, // cobe 2: a brightness factor, not alpha
        markers: [[40.71, -74.0], [51.5, -0.12], [35.68, 139.69], [-33.87, 151.2], [19.08, 72.88], [48.85, 2.35], [-23.55, -46.63]]
          .map(([la, lo]) => ({ location: [la!, lo!] as [number, number], size: 0.035 })),
      });
    };

    const draw = () => {
      const p = reduce ? 0 : progress.current;
      const pe = clamp01((p - 0.08) / 0.8);
      const { cellW, cellH, globe, grid, delay } = layout;
      const a = (angle * Math.PI) / 180;
      const tl = (tilt * Math.PI) / 180;
      for (let i = 0; i < points.length; i++) {
        const el = tileRefs.current[i];
        const pt = points[i];
        const cell = grid[i];
        const wait = delay[i];
        if (!el || !pt || !cell || wait === undefined) continue;
        // rotate around Y (spin), then X (tilt)
        const x1 = pt.x * Math.cos(a) + pt.z * Math.sin(a);
        const z1 = -pt.x * Math.sin(a) + pt.z * Math.cos(a);
        const y2 = pt.y * Math.cos(tl) - z1 * Math.sin(tl);
        const z2 = pt.y * Math.sin(tl) + z1 * Math.cos(tl);
        const gx = globe.cx - cellW / 2 + x1 * globe.R;
        const gy = globe.cy - cellH / 2 + y2 * globe.R;
        const gz = z2 * globe.R;
        let ry = (Math.atan2(x1, z2) * 180) / Math.PI;
        const rx = (-Math.asin(Math.max(-1, Math.min(1, y2))) * 180) / Math.PI;
        const front = (z2 + 1) / 2;
        const t = easeInOut(clamp01((pe - wait) / 0.65));
        ry = ((ry + 540) % 360) - 180;
        const tx = lerp(gx, cell.x, t);
        const ty = lerp(gy, cell.y, t);
        const tz = lerp(gz, 0, t);
        const s = lerp(globe.scale, 1, t);
        el.style.width = `${cellW}px`;
        el.style.height = `${cellH}px`;
        el.style.transform = `translate3d(${tx}px, ${ty}px, ${tz}px) rotateY(${lerp(ry, 0, t)}deg) rotateX(${lerp(rx, 0, t)}deg) scale(${s})`;
        el.style.opacity = String(lerp(0.32 + 0.68 * front, 1, t));
        el.style.zIndex = String(Math.round(lerp(front * 100, 100, t)));
        el.style.pointerEvents = t > 0.95 || front > 0.75 ? 'auto' : 'none';
      }
      if (copyRef.current) {
        const c = clamp01(p * 4);
        copyRef.current.style.opacity = String(1 - c);
        copyRef.current.style.transform = `translateY(${-c * 40}px)`;
        copyRef.current.inert = c > 0.5; // faded copy: not clickable or focusable. The wrapper itself stays pointer-events: none so the globe gets clicks.
      }
      if (earthRef.current) {
        const o = 1 - clamp01(pe * 2);
        earthRef.current.style.transform = `translate3d(${globe.cx - earthSize / 2}px, ${globe.cy - earthSize / 2}px, 0)`;
        earthRef.current.style.opacity = String(o);
        // Same rotation as the tiles. Skip the shader pass when hidden or when nothing moved (paused, at rest).
        if (o > 0 && (a !== lastPhi || tl !== lastTheta)) {
          earth?.update({ phi: a, theta: -tl });
          lastPhi = a; lastTheta = tl;
        }
      }
      if (hintRef.current) hintRef.current.style.opacity = String(1 - clamp01(p * 8));
    };

    const readProgress = () => {
      const r = section.getBoundingClientRect();
      const travel = r.height - window.innerHeight;
      progress.current = travel > 0 ? clamp01(-r.top / travel) : 0;
    };

    const frame = (now: number) => {
      const dt = Math.min(64, now - last) / 1000;
      last = now;
      const before = progress.current;
      readProgress();
      const spin = isPaused() ? 0 : 1 - clamp01(progress.current / 0.25);
      if (!dragging) {
        angle += SPIN_DEG_PER_S * dt * spin + velocity;
        velocity *= 0.94;
        if (Math.abs(velocity) < 0.01) velocity = 0;
        tilt += (-12 - tilt) * 0.04; // drift back to the resting tilt
      }
      draw();
      // Sleep when nothing moves (paused or scrolled past the spin, settled, no scroll); scroll, pointer, resize and resume wake it.
      const still = !dragging && spin === 0 && velocity === 0 && Math.abs(tilt + 12) < 0.05 && progress.current === before;
      raf = visible && !document.hidden && !still ? requestAnimationFrame(frame) : 0;
    };
    const start = () => { if (!raf && !reduce) { last = performance.now(); raf = requestAnimationFrame(frame); } };
    wake.current = start;

    const onResize = () => {
      layout = computeLayout(stage.clientWidth, stage.clientHeight, photos.length);
      const old = earthSize;
      sizeEarth();
      if (earthSize !== old) { earth?.update({ width: earthSize, height: earthSize }); lastPhi = NaN; }
      draw();
      start();
    };
    const onDown = (e: PointerEvent) => {
      start();
      if (reduce || progress.current > 0.1 || e.button !== 0) return;
      // Capture only once the pointer really moves (4px), so a plain click still reaches the tile under it.
      pending = e.pointerId; startX = lastX = e.clientX; startY = lastY = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (pending === e.pointerId && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) {
        dragging = true; velocity = 0; pending = null;
        stage.setPointerCapture(e.pointerId);
        start(); // a drag that begins after the loop slept must wake it
      }
      if (!dragging) return;
      const dx = (e.clientX - lastX) * 0.35;
      const dy = (e.clientY - lastY) * 0.2;
      angle += dx; tilt = Math.max(-40, Math.min(40, tilt - dy)); velocity = dx;
      lastX = e.clientX; lastY = e.clientY;
    };
    const onUp = () => { dragging = false; pending = null; };
    const io = new IntersectionObserver((entries) => { visible = entries.some((e) => e.isIntersecting); if (visible) start(); });
    const onVisibility = () => { if (!document.hidden) start(); };

    readProgress();
    makeEarth();
    draw();
    // Reduced motion draws only now, before cobe's map image has loaded: redraw once it has.
    const redraws = reduce ? [300, 1500].map((ms) => window.setTimeout(() => { lastPhi = NaN; draw(); }, ms)) : [];
    io.observe(section);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', start, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    start();
    return () => {
      cancelAnimationFrame(raf);
      redraws.forEach(clearTimeout);
      earth?.destroy();
      earthHost?.replaceChildren();
      io.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', start);
      document.removeEventListener('visibilitychange', onVisibility);
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onUp);
    };
  }, [photos.length, reduce]);
  useEffect(() => { if (!paused) wake.current(); }, [paused]); // resume wakes a sleeping loop

  return (
    <section ref={sectionRef} aria-label="Introduction" className="g-hero relative">
      <div className="sticky top-0 h-screen overflow-hidden">
        <div
          ref={stageRef}
          className="absolute inset-0 cursor-grab active:cursor-grabbing touch-pan-y"
          style={{ perspective: '1400px' }}
        >
          <div className="absolute inset-0" style={{ transformStyle: 'preserve-3d' }} aria-hidden="true">
            {/* inside the 3D space at z 0, so tiles on the far side of the sphere pass behind the earth */}
            <div ref={earthRef} className="pointer-events-none absolute left-0 top-0" />
            {photos.map((p, i) => (
              <button
                key={p.num}
                ref={(el) => { tileRefs.current[i] = el; }}
                type="button"
                tabIndex={-1}
                className="g-globe-tile"
                style={{ opacity: 0 }}
                onClick={() => onOpen(i)}
              >
                <Image src={p.src} alt="" width={p.width} height={p.height} sizes="(max-width: 640px) 120px, 240px"
                  quality={70} placeholder={p.blurDataUrl ? 'blur' : 'empty'} blurDataURL={p.blurDataUrl} priority={i < 8} />
              </button>
            ))}
          </div>
        </div>

        <div ref={copyRef} className="relative z-[200] mx-auto flex h-full max-w-[1200px] flex-col justify-start px-4 pt-28 lg:justify-center lg:pt-0 sm:px-8 pointer-events-none">
          <div className="max-w-[560px] pointer-events-auto">
            <Reveal as="p" className="g-mono mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs uppercase tracking-[0.14em] g-muted">
              <span className="g-live-dot" aria-hidden="true" /> Licensed photography
            </Reveal>
            <h1 className="g-display text-[56px] sm:text-[84px] lg:text-[112px]">
              <Reveal as="span" className="block g-gradient-text" words>{name}</Reveal>
            </h1>
            {/* B16: the hero's sentence and actions render at rest, with no in-view reveal: a pinned hero can keep
                whileInView from firing, which left an empty gap where the buttons belong. */}
            <p className="g-rise mt-5 max-w-[440px] text-[17px] leading-relaxed text-white/80">
              Editorial and commercial photographs. Pick a frame, tell us how you&apos;ll use it, and the price comes
              straight from the rate card. Pay with PayPal, download the moment it clears.
            </p>
            <div className="g-rise mt-8 flex flex-wrap gap-3" style={{ animationDelay: '120ms' }}>
              <MagneticButton arrow onClick={onRequest}>Request a licence</MagneticButton>
              <MagneticLink variant="ghost" href="#work">See the work</MagneticLink>
            </div>
            <p className="mt-4 text-sm g-muted">Files unlock only after PayPal confirms payment.</p>
            <Reveal delay={0.45} className="mt-10 hidden gap-8 sm:flex">
              {stats.map((s) => (
                <div key={s.label}>
                  {s.value !== undefined && <div className="g-mono text-2xl text-white"><CountUp to={s.value} />{s.suffix}</div>}
                  <div className="mt-1 text-xs g-muted">{s.label}</div>
                </div>
              ))}
            </Reveal>
          </div>
        </div>

        {(
          <div ref={hintRef} className="g-hero-hint pointer-events-none absolute bottom-6 left-1/2 z-[200] -translate-x-1/2 text-xs g-muted flex flex-col items-center gap-2" aria-hidden="true">
            <span>Drag the globe, then scroll</span>
            <span className="block h-8 w-[1px] overflow-hidden bg-white/10">
              <span className="block h-1/2 w-full bg-white/60 animate-[g-scrollhint_1.6s_var(--ease-in-out)_infinite]" />
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
