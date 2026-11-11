'use client';
// /dev/intake: dumb test page (batch-3 §5, fixes 11, 12). All logic lives in POST /api/intake.
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

type Source = 'paste' | 'screenshot' | 'portfolio' | 'form';
type Options = { creatorSlug: string; clients: { id: string; name: string }[]; assets: { id: string; title: string; is_public: boolean }[] };
type Image = { mime: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string; preview: string };
const MIMES = ['image/png', 'image/jpeg', 'image/webp'];

function readImage(file: File): Promise<Image | null> {
  if (!MIMES.includes(file.type)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve({ mime: file.type as Image['mime'], base64: url.slice(url.indexOf(',') + 1), preview: url });
    };
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

export default function DevIntakePage() {
  const [opts, setOpts] = useState<Options | null>(null);
  const [optsError, setOptsError] = useState<string | null>(null);
  const [source, setSource] = useState<Source>('paste');
  const [clientId, setClientId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [text, setText] = useState('');
  const [email, setEmail] = useState('');
  const [fixture, setFixture] = useState('');
  const [image, setImage] = useState<Image | null>(null);
  const [result, setResult] = useState<{ status: number; body: Record<string, unknown> } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadOptions = useCallback(async () => {
    const res = await fetch('/api/options');
    const body = await res.json();
    if (res.ok) { setOpts(body); setOptsError(null); } else { setOpts(null); setOptsError(body.error); }
  }, []);
  useEffect(() => { void loadOptions(); }, [loadOptions]);

  // Fix 12: an image pasted anywhere on the page becomes the screenshot.
  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => MIMES.includes(f.type));
      if (!file) return;
      e.preventDefault();
      const img = await readImage(file);
      if (img) { setImage(img); setSource('screenshot'); }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const creatorSource = source === 'paste' || source === 'screenshot';
  const canSend =
    !busy &&
    (creatorSource ? clientId && assetId : true) &&
    (source === 'screenshot' ? !!image : text.trim().length > 0) &&
    (source === 'portfolio' ? !!assetId && !!email : true) &&
    (source === 'form' ? !!email : true);

  async function send() {
    setBusy(true);
    const f = fixture.trim() || undefined;
    const body =
      source === 'paste' ? { source, clientId, assetId, text, fixture: f }
      : source === 'screenshot' ? { source, clientId, assetId, image: image && { mime: image.mime, base64: image.base64 }, fixture: f }
      : source === 'portfolio' ? { source, assetId, email, text, fixture: f }
      : { source, creatorSlug: opts?.creatorSlug ?? 'imani', assetId: assetId || undefined, email, text, fixture: f };
    const res = await fetch('/api/intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    setResult({ status: res.status, body: await res.json() });
    setBusy(false);
  }

  const briefId = typeof result?.body.briefId === 'string' ? result.body.briefId : null;

  return (
    <main className="mx-auto grid max-w-3xl gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-semibold">Dev: new intake</h1>
        <Link href="/login?next=/dev/intake" className="text-sm underline">Sign in</Link>
      </header>
      {optsError && <p className="text-sm text-destructive">Client and asset lists unavailable: {optsError}</p>}

      <Card>
        <CardHeader><CardTitle>Request</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1">
            <Label>Source</Label>
            <Select value={source} onValueChange={(v) => setSource(v as Source)}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="paste">Pasted text (creator)</SelectItem>
                <SelectItem value="screenshot">DM screenshot (creator)</SelectItem>
                <SelectItem value="portfolio">Portfolio request (public)</SelectItem>
                <SelectItem value="form">Request form (public)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {creatorSource && (
              <div className="grid gap-1">
                <Label>Client</Label>
                <Select value={clientId} onValueChange={setClientId}>
                  <SelectTrigger><SelectValue placeholder="Pick the client" /></SelectTrigger>
                  <SelectContent>
                    {opts?.clients.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                    <SelectItem value="unknown">Unknown sender</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-1">
              <Label>Asset{source === 'form' ? ' (optional)' : ''}</Label>
              <Select value={assetId} onValueChange={setAssetId}>
                <SelectTrigger><SelectValue placeholder="Pick the photo" /></SelectTrigger>
                <SelectContent>
                  {opts?.assets.filter((a) => source !== 'portfolio' || a.is_public).map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.title}{a.is_public ? '' : ' (private)'}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!creatorSource && (
              <div className="grid gap-1">
                <Label htmlFor="email">Requester email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            )}
          </div>

          {source === 'screenshot' ? (
            <div className="grid gap-2">
              <Label htmlFor="file">Screenshot: press Ctrl+V anywhere on this page, or choose a file</Label>
              <Input id="file" type="file" accept={MIMES.join(',')} onChange={async (e) => {
                const f = e.target.files?.[0];
                setImage(f ? await readImage(f) : null);
              }} />
              {image && <img src={image.preview} alt="Screenshot to transcribe" className="max-h-80 w-fit rounded-md border" />}
            </div>
          ) : (
            <div className="grid gap-1">
              <Label htmlFor="text">Message from the client</Label>
              <Textarea id="text" rows={6} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="Paste the client's message. Lines starting with client: / creator: keep that speaker." />
            </div>
          )}

          <div className="grid gap-1">
            <Label htmlFor="fixture">Fixture name (fixture mode only, e.g. demo-dm, paste, negation)</Label>
            <Input id="fixture" value={fixture} onChange={(e) => setFixture(e.target.value)} className="w-64" />
          </div>

          <Button onClick={send} disabled={!canSend} className="w-fit">{busy ? 'Sending...' : 'Send intake'}</Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader><CardTitle>Response {result.status}</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap gap-3 text-sm">
              {briefId && <Link className="underline" href={`/deals/${briefId}`}>Open in deal room</Link>}
            </div>
            <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(result.body, null, 2)}</pre>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
