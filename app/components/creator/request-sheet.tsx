'use client';
// Batch 7C: "Add client request" sheet, reachable from every creator page. Paste a client's message or drop a
// screenshot, pick the client and photo (GET /api/options), and submit to the existing POST /api/intake (same
// contract and same-origin check as /dev/intake). The result is a state card read back from GET /api/briefs/:id:
// every price and rule result comes from the server. Nothing here prices, sends or approves on its own.
import { AlertTriangle, ImagePlus, Plus } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SAMPLES, type Sample } from '@/components/creator/request-samples';
import { StatusBadge } from '@/components/creator/page-bits';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import type { BriefView } from '@/lib/briefs';
import { optionLabel, usd } from '@/lib/format';
import { hasPaidUse } from '@/lib/reasons';

type Options = { clients: { id: string; name: string; email: string }[]; assets: { id: string; title: string }[] };
type Image = { mime: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string; preview: string; name: string };
type Source = 'paste' | 'screenshot';
type Posted = { briefId: string; state: string; autopilot: string | null };
type Result = { posted: Posted; view: BriefView | null };

export const UNKNOWN_CLIENT = 'unknown';
/** Window event that opens the "Add client request" sheet (batch 7C phase 3, quick actions). */
export const OPEN_REQUEST_EVENT = 'useright:add-request';
export const AUTOSEND_WARNING = 'If this matches your settings, UseRight may send the invoice without another click.';
const MIMES = ['image/png', 'image/jpeg', 'image/webp'];
/** review B7C-1 finding 7: the same 5 MB cap as `MAX_IMAGE_BYTES` in lib/intake.ts, checked before reading or posting. */
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
export const TOO_BIG = 'That screenshot is over 5 MB. Crop it or save it smaller.';

function readImage(file: Blob, name: string): Promise<Image | null> {
  if (!MIMES.includes(file.type)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve({ mime: file.type as Image['mime'], base64: url.slice(url.indexOf(',') + 1), preview: url, name });
    };
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

/** The state card shown after a submit. Words for each outcome; numbers only from the read-back view. */
export function RequestResult({ result, onAnother, onLeave }: { result: Result; onAnother: () => void; onLeave: () => void }) {
  const { posted, view } = result;
  const v = view?.version ?? null;
  const status = view?.status ?? null;
  const price = v && (v.status === 'pending' || v.status === 'active') ? v.totalCents : view?.gapPreview?.totalCents ?? null;
  const failing = v?.policy?.results.filter((r) => !r.pass) ?? [];
  const uses = [...new Set(view?.checks?.kept.map((k) => optionLabel(k.optionId)) ?? [])];
  const deal = `/deals/${posted.briefId}`;
  // review B7C-1 finding 5: a hard block (no client email, under the minimum) cannot be approved in Ask me.
  const hardBlock = !!v?.policy?.hardBlock;
  const next = hardBlock ? { href: deal, text: 'Open the deal to fix it' }
    : status === 'needs_approval' ? { href: '/ask', text: 'Open Ask me to approve or reject it' }
      : status === 'awaiting_transcript' || posted.state === 'awaiting_transcript' ? { href: deal, text: 'Confirm the transcript' }
        : { href: deal, text: 'Open the deal room' };
  // review B7C-1 finding 2: the read-back status wins over the intake reply. `autopilot` is null when autopilot threw,
  // possibly after PayPal had the invoice, so "Nothing was sent." is said only when the deal has no quote at all.
  const to = view?.client?.email ?? 'the client';
  const happened = status === 'invoiced' || (posted.autopilot === 'sent' && status !== 'sending' && status !== 'failed') ? `The invoice was sent to ${to} through PayPal.`
    : status === 'sending' ? `The invoice is being sent to ${to} through PayPal. Check the deal in a moment before doing anything else.`
      : status === 'failed' || posted.autopilot === 'failed' ? 'The invoice could not be confirmed as sent. Check the deal before trying again.'
        : hardBlock ? 'It cannot be approved as it is, so nothing was sent. Open the deal and change what the rules list first.'
          : status === 'needs_approval' || posted.autopilot === 'needs_approval' ? 'The rules stopped it, so nothing was sent. It waits for your typed approval.'
            : posted.state === 'awaiting_transcript' ? 'Nothing is read or priced until you confirm who said what.'
              : !view || v ? 'Check the deal before trying again.'
                : 'Nothing was sent.';

  return (
    <section aria-labelledby="request-result-title" tabIndex={-1} id="request-result" className="grid gap-4 rounded-md border bg-card p-4 outline-none">
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="request-result-title" className="text-d-section">Request added</h3>
        {status && <StatusBadge status={status} demo={!!v?.invoice?.demo} paidUse={hasPaidUse(view?.reasons)} />}
      </div>
      {/* review B7C-1 finding 3: when the read-back failed, say the details are unavailable instead of "Unknown sender". */}
      {!view ? (
        <p className="text-body text-muted-foreground">Couldn’t load this deal’s details, so the client, photo, price and rules are not shown here. Open the deal to see them.</p>
      ) : (
      <dl className="grid gap-x-4 gap-y-2 text-body sm:grid-cols-[7rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Client · photo</dt>
        <dd>{view?.client?.name ?? 'Unknown sender'} · {view?.asset?.title ?? 'no photo picked'}</dd>
        <dt className="text-muted-foreground">Found</dt>
        <dd>{uses.length ? uses.join(', ') : 'No uses read yet'}</dd>
        <dt className="text-muted-foreground">Price</dt>
        <dd className="font-mono tabular">{price !== null ? usd(price) : <span className="font-sans text-muted-foreground">No price yet</span>}</dd>
        <dt className="text-muted-foreground">Rules</dt>
        <dd>{!v?.policy ? <span className="text-muted-foreground">Not checked yet</span>
          : v.policy.pass ? 'All rules passed'
            : `Stopped by ${failing.map((r) => r.rule).join(', ')}: ${failing.map((r) => r.message).join(' ')}`}</dd>
      </dl>
      )}
      <p className="text-body">{happened}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild><Link href={next.href} onClick={onLeave}>{next.text}</Link></Button>
        <Button variant="outline" onClick={onAnother}>Add another request</Button>
      </div>
    </section>
  );
}

export function RequestSheet() {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<Options | null>(null);
  const [optsError, setOptsError] = useState<string | null>(null);
  const [source, setSource] = useState<Source>('paste');
  const [text, setText] = useState('');
  const [image, setImage] = useState<Image | null>(null);
  const [clientId, setClientId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [sample, setSample] = useState<Sample | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Batch 7C phase 3: the quick-action box opens this sheet by event, so there is still only one sheet.
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_REQUEST_EVENT, show);
    return () => window.removeEventListener(OPEN_REQUEST_EVENT, show);
  }, []);

  const loadOptions = useCallback(async () => {
    try {
      const res = await fetch('/api/options');
      if (!res.ok) throw new Error(String(res.status));
      setOpts(await res.json());
      setOptsError(null);
    } catch {
      setOptsError('Couldn’t load your clients and photos. Close this and try again.');
    }
  }, []);
  useEffect(() => { if (open && !opts) void loadOptions(); }, [open, opts, loadOptions]);

  // An image pasted while the sheet is open becomes the screenshot.
  useEffect(() => {
    if (!open) return;
    async function onPaste(e: ClipboardEvent) {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => MIMES.includes(f.type));
      if (!file) return;
      e.preventDefault();
      if (file.size > MAX_SCREENSHOT_BYTES) { setError(TOO_BIG); return; }
      const img = await readImage(file, file.name || 'pasted image');
      if (img) { setError(null); setImage(img); setSource('screenshot'); setSample(null); }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open]);

  async function takeFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_SCREENSHOT_BYTES) return setError(TOO_BIG);
    const img = await readImage(file, file.name);
    if (!img) return setError('That file is not a PNG, JPEG or WebP image.');
    setError(null);
    setImage(img);
    setSample(null);
  }

  async function loadSample(s: Sample) {
    setError(null);
    setSource(s.source);
    setSample(s);
    if (s.text) setText(s.text);
    if (s.image) {
      try {
        const blob = await (await fetch(s.image)).blob();
        setImage(await readImage(blob, 'sample DM screenshot'));
      } catch {
        setError('Couldn’t load the sample screenshot.');
      }
    }
    const c = opts?.clients.find((x) => x.email.toLowerCase() === s.clientEmail);
    const a = opts?.assets.find((x) => x.title === s.assetTitle);
    // review B7C-1 finding 1: a sample whose client or photo is missing clears the old pick instead of keeping it.
    setClientId(c?.id ?? '');
    setAssetId(a?.id ?? '');
  }

  function reset() {
    setResult(null);
    setError(null);
    setText('');
    setImage(null);
    setSample(null);
    // review B7C-1 finding 1: a new request never inherits the last recipient or photo.
    setClientId('');
    setAssetId('');
  }

  const hasContent = source === 'paste' ? text.trim().length > 0 : !!image;
  const canSubmit = !busy && hasContent && !!clientId && !!assetId;
  // A sample's fixture only stays while the text is exactly the sample's.
  const fixture = sample && (sample.source === 'screenshot' ? source === 'screenshot' : text === sample.text) ? sample.fixture : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const body = source === 'paste'
      ? { source, clientId, assetId, text, fixture }
      : { source, clientId, assetId, image: { mime: image!.mime, base64: image!.base64 }, fixture };
    try {
      const res = await fetch('/api/intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(`${out.error ?? 'The request was not accepted.'} Your message is still here. Check Deals before trying again.`);
        return;
      }
      const posted: Posted = { briefId: out.briefId, state: out.state, autopilot: out.autopilot ?? null };
      let view: BriefView | null = null;
      try {
        const v = await fetch(`/api/briefs/${posted.briefId}`);
        if (v.ok) view = await v.json();
      } catch { /* the card still links to the deal */ }
      setResult({ posted, view });
      setTimeout(() => document.getElementById('request-result')?.focus(), 0);
    } catch {
      setError('Could not reach the server, so the result is unknown. Your message is still here. Check Deals before trying again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button className="h-11 gap-2 md:h-10">
          <Plus aria-hidden className="size-4" />
          Add client request
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="theme-dashboard dash-glass w-full gap-0 overflow-y-auto border-l text-foreground sm:max-w-xl">
        <SheetHeader className="border-b p-5">
          <SheetTitle className="text-d-section">Add client request</SheetTitle>
          <SheetDescription className="text-body">Paste what the client wrote, or drop a screenshot. UseRight reads it, prices it from your rate card and checks your rules.</SheetDescription>
        </SheetHeader>

        <div className="grid gap-6 p-5">
          {optsError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive-bg p-3 text-body text-destructive">{optsError}</p>}

          {result ? <RequestResult result={result} onAnother={reset} onLeave={() => { setOpen(false); reset(); }} /> : (
            <form onSubmit={submit} className="grid gap-5" noValidate>
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-label">Try a sample</legend>
                <div className="flex flex-wrap gap-2">
                  {SAMPLES.map((s) => (
                    <Button key={s.key} type="button" size="sm" variant="outline" disabled={!opts || busy} onClick={() => void loadSample(s)}>
                      Load sample: {s.label}
                    </Button>
                  ))}
                </div>
                {sample && <p className="text-meta text-muted-foreground">{sample.expect}</p>}
              </fieldset>

              <fieldset className="grid gap-2">
                <legend className="mb-1 text-label">What did the client send?</legend>
                <RadioGroup value={source} onValueChange={(v) => setSource(v as Source)} className="flex flex-wrap gap-x-6 gap-y-2" aria-label="What did the client send?">
                  {(['paste', 'screenshot'] as const).map((s) => (
                    <Label key={s} htmlFor={`req-src-${s}`} className="flex min-h-11 cursor-pointer items-center gap-2 font-normal">
                      <RadioGroupItem id={`req-src-${s}`} value={s} />
                      {s === 'paste' ? 'Pasted text' : 'Screenshot'}
                    </Label>
                  ))}
                </RadioGroup>
              </fieldset>

              {source === 'paste' ? (
                <div className="grid gap-2">
                  <Label htmlFor="req-text">Client’s message</Label>
                  <Textarea id="req-text" rows={7} value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
                    aria-describedby="req-text-hint" placeholder="Paste the message here." />
                  <p id="req-text-hint" className="text-meta text-muted-foreground">To keep who said what, start every line with “client:” or “creator:”.</p>
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="req-file">Screenshot (PNG, JPEG or WebP, up to 5 MB)</Label>
                  <div
                    className="grid min-h-28 place-items-center gap-2 rounded-md border border-dashed p-4 text-center text-body text-muted-foreground"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); void takeFile(e.dataTransfer.files?.[0]); }}
                  >
                    <ImagePlus aria-hidden className="size-5" />
                    <p>Drop the screenshot here, paste it with Ctrl+V, or choose a file.</p>
                    <input ref={fileRef} id="req-file" type="file" accept={MIMES.join(',')} disabled={busy}
                      className="max-w-full text-meta file:mr-3 file:rounded-md file:border file:bg-card file:px-3 file:py-1.5 file:text-foreground"
                      onChange={(e) => void takeFile(e.target.files?.[0])} />
                  </div>
                  {image && (
                    <figure className="grid gap-1">
                      <img src={image.preview} alt="Screenshot to read" className="max-h-64 w-fit rounded-md border object-contain" />
                      <figcaption className="text-meta text-muted-foreground">Preview: {image.name}. You confirm the transcript before anything is priced.</figcaption>
                    </figure>
                  )}
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="req-client">Client</Label>
                  <Select value={clientId} onValueChange={setClientId} disabled={!opts || busy}>
                    <SelectTrigger id="req-client" className="h-11 w-full"><SelectValue placeholder="Pick the client" /></SelectTrigger>
                    <SelectContent>
                      {opts?.clients.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                      <SelectItem value={UNKNOWN_CLIENT}>Not sure (unknown sender)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="req-photo">Photo</Label>
                  <Select value={assetId} onValueChange={setAssetId} disabled={!opts || busy}>
                    <SelectTrigger id="req-photo" className="h-11 w-full"><SelectValue placeholder="Pick the photo" /></SelectTrigger>
                    <SelectContent>{opts?.assets.map((a) => <SelectItem key={a.id} value={a.id}>{a.title}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>

              <Alert variant="warning">
                <AlertTriangle aria-hidden />
                <AlertDescription className="text-body">{AUTOSEND_WARNING}</AlertDescription>
              </Alert>

              {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive-bg p-3 text-body text-destructive">{error}</p>}

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" className="h-11" disabled={!canSubmit}>{busy ? 'Sending request…' : 'Add request'}</Button>
                {!canSubmit && !busy && (
                  <p className="text-meta text-muted-foreground">
                    {!hasContent ? (source === 'paste' ? 'Paste the message first.' : 'Add the screenshot first.') : 'Pick the client and the photo.'}
                  </p>
                )}
              </div>
            </form>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
