'use client';
// /portfolio (docs/ui/portfolio.md): the creator's photos and which are on the public page, over GET /api/portfolio
// (read-only). Upload, visibility changes and publishing have no handler, so the page shows no control or placeholder
// for them (batch 12). "Shown" means the public page really shows it (`onPublicPage`), not just the public flag.
import { ChevronDown, Eye, EyeOff, ImageOff } from 'lucide-react';
import Link from 'next/link';
import { HelpPanel } from '@/components/creator/guide';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, LoadError, LoadingRows, PageHeader, STACK, useCopy } from '@/components/creator/page-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PortfolioPhoto } from '@/lib/portfolio';
import { usd } from '@/lib/format';

type Asset = {
  id: string; title: string; isPublic: boolean; onPublicPage: boolean; createdAt: string; photo: PortfolioPhoto | null;
  // Batch 7C (optional so an older response still renders)
  licensed?: number; activeLicences?: number; earnedLiveCents?: number; earnedDemoCents?: number;
};
type Portfolio = { creatorSlug: string; publicPath: string; assets: Asset[] };

function Visibility({ a }: { a: Asset }) {
  if (a.onPublicPage) {
    return (
      <Badge variant="outline" className="gap-1.5 py-1 text-label font-normal">
        <Eye aria-hidden className="size-3.5" />Shown on public portfolio
      </Badge>
    );
  }
  if (a.isPublic) {
    return (
      <Badge variant="outline" className="gap-1.5 py-1 text-label font-normal text-muted-foreground">
        <ImageOff aria-hidden className="size-3.5" />Public, not on the page (no portfolio photo)
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1.5 py-1 text-label font-normal text-muted-foreground">
      <EyeOff aria-hidden className="size-3.5" />Private
    </Badge>
  );
}

export default function PortfolioPage() {
  const router = useRouter();
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { note: copyNote, copy } = useCopy('Portfolio link copied.', 'Couldn’t copy. Select the link to copy it.');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/portfolio');
      if (res.status === 401) return router.replace('/login?next=/portfolio');
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setError(null);
    } catch {
      setError('Couldn’t load your photos. Try again.');
    } finally {
      setLoading(false);
    }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  const shownCount = data?.assets.filter((a) => a.onPublicPage).length ?? 0;
  const activeLicences = data?.assets.reduce((sum, a) => sum + (a.activeLicences ?? 0), 0) ?? 0;
  const earnedLiveCents = data?.assets.reduce((sum, a) => sum + (a.earnedLiveCents ?? 0), 0) ?? 0;
  const earnedDemoCents = data?.assets.reduce((sum, a) => sum + (a.earnedDemoCents ?? 0), 0) ?? 0;

  return (
    <section>
      <PageHeader title="Portfolio" description="Your photos and which ones clients can see on your public page." />
      <HelpPanel id="portfolio">
        <p>Your photos, and which ones clients see on your public page.</p>
        <p>A client can open the public page, pick a photo and send a licence request. Their request shows up in Deals right away, marked Waiting for email confirmation. Open it to send them the confirm link. Public pages show previews only; the licensed file unlocks after PayPal confirms payment.</p>
      </HelpPanel>
      {error && <LoadError message={error} onRetry={() => void load()} retrying={loading} />}

      {data === null && !error && <LoadingRows label="Loading your photos…" rows={5} height="h-20" />}
      {data?.assets.length === 0 && <EmptyState>No photos yet. Run <code className="font-mono text-id">npm run db:init</code> to add the demo photos.</EmptyState>}

      {data && data.assets.length > 0 && (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <Card className="py-4">
              <CardContent className="px-4">
                <div className="grid gap-1">
                  <span className="text-meta font-medium text-muted-foreground">Shown on your public page</span>
                  <span className="font-mono text-xl font-semibold tabular text-foreground">{shownCount} of {data.assets.length} photos</span>
                </div>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent className="px-4">
                <div className="grid gap-1">
                  <span className="text-meta font-medium text-muted-foreground">Active licences</span>
                  <span className="font-mono text-xl font-semibold tabular text-foreground">{activeLicences}</span>
                </div>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent className="px-4">
                <div className="grid gap-1">
                  <span className="text-meta font-medium text-muted-foreground">Earned (PayPal-verified)</span>
                  <span className="font-mono text-xl font-semibold tabular text-foreground">{usd(earnedLiveCents)}</span>
                  {earnedDemoCents > 0 && <span className="text-meta text-muted-foreground">plus {usd(earnedDemoCents)} seeded demo</span>}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card className="mb-8">
            <CardHeader className="pb-3">
              <CardTitle id="publish-title" className="text-d-section font-semibold">Your public page</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 pt-0">
              <p className="text-body">
                <span className="font-mono tabular">{shownCount}</span> of your {data.assets.length} photos are shown at{' '}
                <span className="font-mono text-id break-all">{data.publicPath}</span>.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild variant="outline" className="h-11 md:h-10"><Link href={data.publicPath}>View portfolio</Link></Button>
                <Button variant="ghost" className="h-11 md:h-10" onClick={() => void copy(new URL(data.publicPath, window.location.origin).href)}>Copy link</Button>
                <p aria-live="polite" className="text-meta text-muted-foreground">{copyNote}</p>
              </div>
            </CardContent>
          </Card>

          <div className="mb-3">
            <p className="text-body text-muted-foreground">Previews only. The licensed file unlocks after PayPal confirms payment.</p>
          </div>

          <Card className="py-0 overflow-hidden border">
            <Table className="text-body!">
              <TableCaption className="sr-only">Your photos in upload order</TableCaption>
              <TableHeader className="max-md:sr-only">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-10 w-24 px-3 text-meta font-medium text-muted-foreground">Preview</TableHead>
                  <TableHead className="h-10 px-3 text-meta font-medium text-muted-foreground">Title</TableHead>
                  <TableHead className="h-10 px-3 text-meta font-medium text-muted-foreground">Public portfolio</TableHead>
                  <TableHead className="h-10 px-3 text-meta font-medium text-muted-foreground">File</TableHead>
                  <TableHead className="h-10 px-3 text-meta font-medium text-muted-foreground">Licences</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.assets.map((a) => (
                  <TableRow key={a.id} className="max-md:grid max-md:grid-cols-[4rem_minmax(0,1fr)] max-md:gap-x-4 max-md:gap-y-1 max-md:py-3">
                    <TableCell className={`px-3 py-2 align-middle max-md:row-span-3 ${STACK}`}>
                      {a.photo ? (
                        <img src={a.photo.src} alt={a.photo.alt} width={64} height={48} loading="lazy" decoding="async"
                          className="h-12 w-16 rounded-sm object-cover"
                          style={{ backgroundImage: `url(${a.photo.blurDataUrl})`, backgroundSize: 'cover' }} />
                      ) : (
                        <span className="flex h-12 w-16 items-center justify-center rounded-sm bg-muted px-1 text-center text-[0.6875rem] leading-tight whitespace-normal text-muted-foreground">Original asset</span>
                      )}
                    </TableCell>
                    <TableCell className={`px-3 py-2 align-middle font-medium whitespace-normal ${STACK}`}>{a.title}</TableCell>
                    <TableCell className={`px-3 py-2 align-middle whitespace-normal ${STACK}`}><Visibility a={a} /></TableCell>
                    <TableCell className={`px-3 py-2 align-middle text-muted-foreground max-md:text-meta ${STACK}`}>
                      {a.photo ? `${a.photo.orientation === 'portrait' ? 'Portrait' : 'Landscape'}, ${a.photo.width} × ${a.photo.height}` : 'Original asset, no preview file here'}
                    </TableCell>
                    <TableCell className={`px-3 py-2 align-middle whitespace-normal max-md:col-start-2 max-md:text-meta ${STACK}`}>
                      <span className="block">{a.licensed ?? 0} licensed · {a.activeLicences ?? 0} active</span>
                      <span className="block font-mono text-id">{usd(a.earnedLiveCents ?? 0)} earned</span>
                      {!!a.earnedDemoCents && <span className="block text-meta text-muted-foreground">plus {usd(a.earnedDemoCents)} seeded demo</span>}
                      {a.onPublicPage && data && <a href={data.publicPath} target="_blank" rel="noreferrer" className="text-meta underline underline-offset-4">See on public page<span className="sr-only"> (opens in a new tab)</span></a>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <Collapsible className="mt-6">
            <CollapsibleTrigger className="flex items-center gap-1.5 text-meta text-muted-foreground hover:text-foreground">
              <ChevronDown aria-hidden className="size-3.5" />
              Photo credits
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 text-meta text-muted-foreground">
              <p>
                Placeholder photos: Morning Pour is CC0; the others are from Unsplash, used under the Unsplash License. <a className="underline underline-offset-4" href="/portfolio/imani/CREDITS.md">Credits</a>
              </p>
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </section>
  );
}
