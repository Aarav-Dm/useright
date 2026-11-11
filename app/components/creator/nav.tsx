'use client';
// Creator navigation (docs/ui/README.md shell): 208px side nav at >=768px, a 56px bar with a labelled Menu sheet below.
// Dark cinematic look: the selected item sits on a glass pill that slides between items (motion layoutId).
// MotionConfig reducedMotion="user" turns the slide off for people who ask for reduced motion.
import { FlaskConical, Images, Inbox, LayoutDashboard, Menu, ScrollText, ShieldCheck, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutGroup, MotionConfig, motion } from 'motion/react';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

const ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/overview', label: 'Overview', icon: LayoutDashboard },
  { href: '/deals', label: 'Deals', icon: Inbox },
  { href: '/ask', label: 'Ask me', icon: ShieldCheck },
  { href: '/ledger', label: 'Ledger', icon: ScrollText },
  { href: '/portfolio', label: 'Portfolio', icon: Images },
  { href: '/settings', label: 'Settings', icon: SlidersHorizontal },
];

const isActive = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

function Wordmark() {
  return <span className="text-label font-semibold tracking-[-0.01em]">UseRight</span>;
}

/**
 * Batch 7C: how many quotes wait in Ask me for typed approval (from GET /api/ask), re-read on every page change.
 * review B7C-2 finding 4 / review B7C-2 finding 2: hard blocks and failed sends are left out, the same count Overview shows.
 */
export function useAskCount(path: string) {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/ask').then(async (r) => {
      if (!r.ok) return;
      const body = await r.json() as { items?: { hardBlock?: boolean; sendError?: string | null }[] };
      if (live && Array.isArray(body.items)) setN(body.items.filter((i) => !i.hardBlock && !i.sendError).length);
    }).catch(() => {});
    return () => { live = false; };
  }, [path]);
  return n;
}

/** Batch 8: the Demo panel item, only when the layout says demo mode is on (it is hidden in live mode). */
const DEMO_ITEM = { href: '/demo', label: 'Demo', icon: FlaskConical };
const itemsFor = (demo: boolean) => (demo ? [...ITEMS, DEMO_ITEM] : ITEMS);

function NavLinks({ onNavigate, demo = false }: { onNavigate?: () => void; demo?: boolean }) {
  const path = usePathname() ?? '';
  const askCount = useAskCount(path);
  const group = useId(); // desktop nav and mobile sheet each get their own pill
  return (
    <MotionConfig reducedMotion="user">
    <LayoutGroup id={group}>
    <ul className="flex flex-col gap-0.5">
      {itemsFor(demo).map(({ href, label, icon: Icon }) => {
        const active = isActive(path, href);
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              data-press
              className={`relative isolate flex min-h-10 items-center gap-2.5 rounded-full px-3 text-label hover:text-foreground ${
                active ? 'font-semibold text-foreground' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="nav-pill"
                  aria-hidden
                  className="absolute inset-0 -z-10 rounded-full border bg-accent"
                  transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
                />
              )}
              <Icon aria-hidden className="size-4 shrink-0" />
              {label}
              {href === '/ask' && !!askCount && (
                <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-warning/50 bg-warning-bg px-1.5 font-mono text-[0.6875rem] text-warning">
                  {askCount}<span className="sr-only"> waiting</span>
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
    </LayoutGroup>
    </MotionConfig>
  );
}

function useSignOut() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  async function signOut() {
    setState('busy');
    try {
      const res = await fetch('/api/logout', { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      router.replace('/login');
    } catch {
      setState('error');
    }
  }
  return { state, signOut };
}

function SignOut() {
  const { state, signOut } = useSignOut();
  return (
    <div className="flex flex-col gap-1">
      <Button variant="outline" size="sm" onClick={signOut} disabled={state === 'busy'} className="w-full justify-start">
        {state === 'busy' ? 'Signing out…' : 'Sign out'}
      </Button>
      {state === 'error' && <p role="status" className="text-meta text-destructive">Couldn’t sign out. Try again.</p>}
    </div>
  );
}

/** Desktop side navigation. */
export function CreatorNav({ demo = false }: { demo?: boolean }) {
  return (
    <nav aria-label="Dashboard" className="sticky top-0 flex h-dvh flex-col gap-6 px-3 py-5">
      <div className="px-3"><Wordmark /></div>
      <NavLinks demo={demo} />
      <div className="mt-auto"><SignOut /></div>
    </nav>
  );
}

/** Compact bar under 768px: Menu opens the same links in a sheet; the current page name stays visible. */
export function MobileNav({ demo = false }: { demo?: boolean }) {
  const path = usePathname() ?? '';
  const [open, setOpen] = useState(false);
  const current = itemsFor(demo).find((i) => isActive(path, i.href))?.label ?? 'Dashboard';
  // review B7C-2 finding 4: the waiting count shows on the mobile Menu button too, not only inside the sheet.
  const askCount = useAskCount(path);
  return (
    <div className="flex h-14 items-center gap-3 px-4">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="sm" className="h-11 gap-2 px-3">
            <Menu aria-hidden className="size-4" />
            Menu
            {!!askCount && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-warning/50 bg-warning-bg px-1.5 font-mono text-[0.6875rem] text-warning">
                {askCount}<span className="sr-only"> waiting in Ask me</span>
              </span>
            )}
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="theme-dashboard dash-glass w-72 gap-6 border-r p-3 text-foreground">
          <SheetHeader className="px-3 pt-2 pb-0">
            <SheetTitle><Wordmark /></SheetTitle>
            <SheetDescription className="sr-only">Dashboard navigation</SheetDescription>
          </SheetHeader>
          <nav aria-label="Dashboard"><NavLinks demo={demo} onNavigate={() => setOpen(false)} /></nav>
          <div className="mt-auto"><SignOut /></div>
        </SheetContent>
      </Sheet>
      <span className="text-label font-semibold">{current}</span>
    </div>
  );
}
