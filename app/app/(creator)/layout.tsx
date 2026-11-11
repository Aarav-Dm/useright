// Creator dashboard shell (batch-4 §1, docs/ui/README.md shell). Creator-only: no valid session cookie -> /login.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { DashToolbar } from '@/components/creator/dash-toolbar';
import { CreatorNav, MobileNav } from '@/components/creator/nav';
import { CREATOR_COOKIE, sessionCreatorSlug, tokenMatches } from '@/lib/auth';
import { demoMode } from '@/lib/clock';

export default async function CreatorLayout({ children }: { children: ReactNode }) {
  const token = (await cookies()).get(CREATOR_COOKIE)?.value;
  if (!tokenMatches(token)) redirect('/login');
  return (
    <div className="theme-dashboard dash-canvas min-h-dvh text-body text-foreground md:grid md:grid-cols-[13rem_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-label text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <header className="dash-glass sticky top-0 z-40 border-b md:hidden">
        <MobileNav demo={demoMode()} />
      </header>
      <aside className="dash-glass hidden border-r md:block">
        <CreatorNav demo={demoMode()} />
      </aside>
      <main id="main" tabIndex={-1} className="min-w-0 px-4 py-6 outline-none md:px-8 md:py-8">
        <div className="mx-auto w-full max-w-[63rem]">
          <DashToolbar slug={sessionCreatorSlug()} />
          {children}
        </div>
      </main>
    </div>
  );
}
