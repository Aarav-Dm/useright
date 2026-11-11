'use client';
// Batch 7C: "Share request page". Copies the public portfolio link, where clients send a licence request themselves
// (the existing public form). Read-only: no new route, no write.
import { Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCopy } from '@/components/creator/page-bits';
import { Button } from '@/components/ui/button';

export function SharePage({ slug }: { slug: string }) {
  const path = `/c/${slug}`;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(path);
  const { note, copy } = useCopy('Link copied.', 'Couldn’t copy. Select the link to copy it.');
  useEffect(() => { setUrl(new URL(path, window.location.origin).href); }, [path]);

  return (
    <div className="contents">
      <Button variant="outline" className="h-11 gap-2 md:h-10" aria-expanded={open} aria-controls="share-panel" onClick={() => setOpen(!open)}>
        <Share2 aria-hidden className="size-4" />
        Share request page
      </Button>
      {open && (
        <div id="share-panel" className="dash-glass order-last grid w-full gap-2 rounded-md border p-4 text-body">
          <p>Clients can request a licence themselves on your public page. Their request shows up in Deals right away, marked Waiting for email confirmation. Open it to send them the confirm link.</p>
          <p className="font-mono text-id break-all">{url}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void copy(url)}>Copy link</Button>
            <Button size="sm" variant="ghost" asChild><a href={path} target="_blank" rel="noreferrer">Open page<span className="sr-only"> (opens in a new tab)</span></a></Button>
            <p aria-live="polite" className="text-meta text-muted-foreground">{note}</p>
          </div>
        </div>
      )}
    </div>
  );
}
