'use client';
// /login (batch-4 fix 5, docs/ui/login.md): exchanges the creator token for an httpOnly session cookie.
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!res.ok) {
        setError(res.status === 401 ? 'That creator token wasn’t recognised. Check it and try again.' : 'Couldn’t sign in. Check your connection and try again.');
        input.current?.focus();
        return;
      }
      // Only same-site paths, so the link cannot bounce somewhere else (review 25: no `//` or `/\`, which some browsers treat as a host).
      router.replace(next && /^\/(?![/\\])/.test(next) ? next : '/deals');
    } catch {
      setError('Couldn’t sign in. Check your connection and try again.');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-6" noValidate>
      <div className="grid gap-2">
        <Label htmlFor="token">Creator token</Label>
        <Input
          ref={input} id="token" type="password" autoComplete="current-password" className="h-11" value={token} required
          aria-invalid={error ? true : undefined} aria-describedby={error ? 'login-error' : undefined}
          onChange={(e) => { setToken(e.target.value); if (error) setError(null); }}
        />
      </div>
      {error && <p id="login-error" role="alert" className="rounded-md border border-destructive/40 bg-destructive-bg p-3 text-body text-destructive">{error}</p>}
      <Button type="submit" className="h-11 w-full" disabled={busy || !token}>{busy ? 'Signing in…' : 'Sign in'}</Button>
    </form>
  );
}

export function LoginScreen({ demo }: { demo: boolean }) {
  const devpostUrl = process.env.NEXT_PUBLIC_DEVPOST_URL?.trim();
  return (
    <main className="theme-dashboard dash-canvas grid min-h-dvh px-4 pt-16 text-foreground md:place-items-center md:p-8">
      <section aria-labelledby="login-title" className="dash-enter dash-glass grid w-full max-w-[25rem] content-start gap-6 rounded-lg border p-6 md:p-8">
        <div className="grid gap-2">
          <p className="text-label font-semibold tracking-[-0.01em] text-muted-foreground">UseRight</p>
          <h1 id="login-title" className="text-d-page">Sign in to UseRight</h1>
          <p className="text-meta text-muted-foreground">Creator workspace</p>
        </div>
        {demo && (
          <div className="grid gap-2 text-body">
            {/* B11 items 4 and 7: same sentence as the film's opening. Opened replacement quote, docs/reference/pain-check.md:45. */}
            <p className="text-muted-foreground">A wedding photographer wrote: “The agreement allowed social media use with credit, but specifically prohibited website use and any printed marketing materials.”</p>
            <p className="text-meta text-muted-foreground">From <a href="https://www.reddit.com/r/WeddingPhotography/comments/1u7ekn1/venue_copyright_breach_use_of_wedding_images/" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">a post on r/WeddingPhotography</a>.</p>
            <p>UseRight invoices the gap; the file unlocks only when PayPal confirms payment.</p>
            <Link href="/c/imani" className="w-fit underline underline-offset-4">See a creator’s public page</Link>
          </div>
        )}
        <Suspense fallback={<p role="status" className="text-body text-muted-foreground">Opening sign-in…</p>}>
          <LoginForm />
        </Suspense>
        <p className="max-w-[48ch] text-meta text-muted-foreground">Clients don’t sign in here. They use the payment link in their invoice.</p>
        {demo && <p className="max-w-[48ch] text-meta text-muted-foreground">Reviewing this entry? The demo login is in the {devpostUrl ? <a href={devpostUrl} className="underline underline-offset-4">testing instructions on Devpost</a> : 'testing instructions on Devpost'}.</p>}
      </section>
    </main>
  );
}
