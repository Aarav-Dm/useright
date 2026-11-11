'use client';
// /settings (batch-4 §4, docs/ui/settings.md). Form over GET/PUT /api/settings; the server validates everything.
// Dollars are display text; the API takes integer cents. No autosave for money or permissions.
import { useRouter } from 'next/navigation';
import { HelpPanel } from '@/components/creator/guide';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LoadError, LoadingRows, PageHeader } from '@/components/creator/page-bits';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TermTip } from '@/components/creator/explain';
import { PriceCalculator } from '@/components/creator/price-calculator';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { optionLabel } from '@/lib/format';
import { parseCents } from '@/lib/money';
import type { SettingsView } from '@/lib/settings';

const SELLABLE = ['social', 'web', 'print', 'billboard', 'OOH', 'TV', 'exclusive'] as const;
type Mode = 'auto' | 'ask' | 'off';
// review 3: the server only knows "may sell on its own" (auto_channels). Ask and Not listed both send a request to you,
// and you can still approve it by hand, so neither label promises the option cannot be sold.
const MODE_LABEL: Record<Mode, string> = { auto: 'Agent sells on its own', ask: 'Always ask me', off: 'Not listed (still comes to you)' };
const LONG_LABEL: Record<string, string> = { OOH: 'Out-of-home advertising', TV: 'Television', exclusive: 'Exclusive rights' };
const CARD_GROUPS: { title: string; ids: string[] }[] = [
  { title: 'Channels', ids: ['social', 'web', 'print', 'billboard', 'OOH', 'TV'] },
  { title: 'Territory', ids: ['US', 'NA', 'WORLD'] },
  { title: 'Term', ids: ['6mo', '12mo'] },
];

const toDollars = (c: number) => (c / 100).toFixed(2);
/** Dollar text -> integer cents with the shared strict parser; NaN when invalid, so the server names the issue. */
const toCents = (s: string) => parseCents(s) ?? Number.NaN;

/** Server issue path -> the input it belongs to. */
function fieldFor(path: string): string {
  if (path.startsWith('rateCard.')) return `rc-${path.slice('rateCard.'.length).split('.')[0]}`;
  return ({ perDealCapCents: 'cap', rolling30CapCents: 'r30', dailyMaxSends: 'daily', timezone: 'tz', autoChannels: 'perm', askChannels: 'perm', allowedClientIds: 'clients' } as Record<string, string>)[path.split('.')[0]!] ?? 'summary';
}

/** What an error-summary link says: the field's own label, not the API path. */
function fieldLabel(field: string): string {
  if (field.startsWith('rc-')) { const id = field.slice(3); return `${LONG_LABEL[id] ?? optionLabel(id)} price`; }
  return ({ cap: 'Per-deal cap', r30: 'Per-client 30-day cap', daily: 'Sends per day', tz: 'Time zone', perm: 'What the agent may sell', clients: 'Clients the agent may invoice' } as Record<string, string>)[field] ?? 'Settings';
}

function Group({ title, id, children, description, tip }: { title: string; id: string; children: ReactNode; description?: string; tip?: 'autopilot' }) {
  return (
    <section id={id} tabIndex={-1} aria-labelledby={`${id}-title`} className="outline-none">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CardTitle id={`${id}-title`} className="text-d-section font-semibold">{title}</CardTitle>
            {tip && <TermTip term={tip} />}
          </div>
          {description && <CardDescription className="max-w-prose text-body text-muted-foreground">{description}</CardDescription>}
        </CardHeader>
        <CardContent className="grid gap-5 pt-0">
          {children}
        </CardContent>
      </Card>
    </section>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const [loaded, setLoaded] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [card, setCard] = useState<Record<string, string>>({});
  const [caps, setCaps] = useState({ perDeal: '', rolling30: '', dailyMax: '' });
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [allowed, setAllowed] = useState<string[]>([]);
  const [timezone, setTimezone] = useState('');
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [baseline, setBaseline] = useState('');
  const summaryRef = useRef<HTMLDivElement>(null);

  const snapshot = useMemo(() => JSON.stringify({ card, caps, modes, allowed: [...allowed].sort(), timezone }), [card, caps, modes, allowed, timezone]);
  const dirty = loaded !== null && snapshot !== baseline;

  function fill(s: SettingsView) {
    const nextCard = Object.fromEntries(Object.entries(s.rateCard).map(([k, v]) => [k, toDollars(v)]));
    const nextCaps = { perDeal: toDollars(s.perDealCapCents), rolling30: toDollars(s.rolling30CapCents), dailyMax: String(s.dailyMaxSends) };
    const nextModes = Object.fromEntries(SELLABLE.map((c) => [c, s.autoChannels.includes(c) ? 'auto' : s.askChannels.includes(c) ? 'ask' : 'off'])) as Record<string, Mode>;
    setLoaded(s);
    setCard(nextCard);
    setCaps(nextCaps);
    setModes(nextModes);
    setAllowed(s.allowedClientIds);
    setTimezone(s.timezone);
    setBaseline(JSON.stringify({ card: nextCard, caps: nextCaps, modes: nextModes, allowed: [...s.allowedClientIds].sort(), timezone: s.timezone }));
  }

  const load = useCallback(async () => {
    setLoadingSettings(true);
    try {
      const res = await fetch('/api/settings');
      if (res.status === 401) return router.replace('/login?next=/settings');
      if (!res.ok) throw new Error(String(res.status));
      fill(await res.json());
      setLoadError(null);
    } catch {
      setLoadError('Couldn’t load your settings. Try again.');
    } finally {
      setLoadingSettings(false);
    }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setIssues([]);
    setNotice(null);
    setSaveError(null);
    const body = {
      rateCard: Object.fromEntries(Object.entries(card).map(([k, v]) => [k, toCents(v)])),
      perDealCapCents: toCents(caps.perDeal),
      rolling30CapCents: toCents(caps.rolling30),
      dailyMaxSends: /^\d+$/.test(caps.dailyMax.trim()) ? Number(caps.dailyMax) : Number.NaN,
      autoChannels: SELLABLE.filter((c) => modes[c] === 'auto'),
      askChannels: SELLABLE.filter((c) => modes[c] === 'ask'),
      allowedClientIds: allowed,
      timezone: timezone.trim(),
    };
    try {
      const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setIssues(out.issues ?? [{ path: 'body', message: out.error ?? 'The server refused these settings.' }]);
        setTimeout(() => summaryRef.current?.focus(), 0);
        return;
      }
      fill(out);
      setNotice('Settings saved. Existing licences keep the prices they were sold at.');
    } catch {
      setSaveError('Couldn’t save settings. Your changes are still here. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <section>
        <PageHeader title="Settings" />
        {loadError ? <LoadError message={loadError} onRetry={() => void load()} retrying={loadingSettings} /> : <LoadingRows label="Loading your rates and limits…" rows={4} height="h-24" />}
      </section>
    );
  }

  const clearIssues = (field: string) => setIssues((all) => all.filter((i) => fieldFor(i.path) !== field));
  const issueFor = (field: string) => issues.filter((i) => fieldFor(i.path) === field).map((i) => i.message).join(' ');
  const field = (id: string, label: string, value: string, set: (v: string) => void, opts: { inputMode?: 'decimal' | 'numeric' | 'text'; prefix?: string; className?: string; placeholder?: string; hint?: string } = {}) => {
    const err = issueFor(id);
    return (
      <div className={`grid content-start gap-1.5 ${opts.className ?? ''}`}>
        <Label htmlFor={id}>{label}</Label>
        <div className="relative">
          {opts.prefix && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">{opts.prefix}</span>}
          <Input id={id} inputMode={opts.inputMode ?? 'decimal'} className={`h-11 font-mono ${opts.prefix ? 'pl-7' : ''}`} value={value} placeholder={opts.placeholder}
            aria-invalid={err ? true : undefined} aria-describedby={err ? `${id}-err` : undefined} disabled={busy}
            onChange={(e) => { set(e.target.value); setNotice(null); clearIssues(id); }} />
        </div>
        {opts.hint && !err && <p className="text-meta text-muted-foreground">{opts.hint}</p>}
        {err && <p id={`${id}-err`} className="text-meta text-destructive">{err}</p>}
      </div>
    );
  };

  const autoChannelCount = SELLABLE.filter((c) => modes[c] === 'auto').length;
  const parsedCapCents = parseCents(caps.perDeal);
  const displayCap = parsedCapCents !== null
    ? `$${(parsedCapCents / 100).toFixed(2)}`
    : caps.perDeal.trim() === ''
    ? '$0.00'
    : 'Draft';

  return (
    <form onSubmit={save} className="grid max-w-[60rem] gap-6" noValidate>
      <PageHeader title="Settings" description="Your rate card and what the agent may do without asking." />
      <HelpPanel id="settings">
        <p><strong>Rate card</strong>: what each use costs. A price is the sum of the channels, the territory and the term. Changing it never changes licences already sold.</p>
        <p><strong>Autopilot limits</strong> and <strong>What the agent may sell</strong>: the agent sends an invoice on its own only when every rule passes. Anything over a limit, or set to ask you, waits in Ask me for your typed total.</p>
        <p>Nothing is saved until you choose Save settings.</p>
      </HelpPanel>

      <Card className="py-4">
        <CardContent className="px-6 py-0">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1">
              <span className="text-meta font-medium text-muted-foreground">Agent sells on its own</span>
              <span className="font-mono text-xl font-semibold tabular text-foreground">{autoChannelCount} of {SELLABLE.length} channels</span>
            </div>
            <div className="grid gap-1">
              <span className="text-meta font-medium text-muted-foreground">Per-deal cap</span>
              <span className="font-mono text-xl font-semibold tabular text-foreground">{displayCap}</span>
            </div>
            <div className="grid gap-1">
              <span className="text-meta font-medium text-muted-foreground">Sends per day</span>
              <span className="font-mono text-xl font-semibold tabular text-foreground">{caps.dailyMax || '0'}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {issues.length > 0 && (
        <div ref={summaryRef} tabIndex={-1} aria-labelledby="summary-title" id="summary" className="grid gap-2 rounded-md border border-destructive/40 bg-destructive-bg p-4 text-body text-destructive outline-none">
          <p id="summary-title" className="font-medium">Check the highlighted settings.</p>
          <ul className="grid gap-1">
            {issues.map((i, k) => {
              const f = fieldFor(i.path);
              return (
                <li key={k}>
                  {f === 'summary' ? <span className="font-medium">{fieldLabel(f)}</span> : (
                    <a className="underline underline-offset-4" href={`#${f}`}
                      onClick={(e) => { const el = document.getElementById(f); if (el) { e.preventDefault(); el.focus(); } }}>
                      {fieldLabel(f)}
                    </a>
                  )}: {i.message}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Group title="Rate card" id="g-card" description="Each option adds to the price. Every licence freezes the card it was sold at.">
        {CARD_GROUPS.map((g) => (
          // B16: each rate-card group gets its own band, so "Territory" and "Term" no longer sit on the hint above.
          <div key={g.title} className="grid gap-3 border-t pt-5 first:border-t-0 first:pt-0">
            <p className="text-label font-medium">{g.title}</p>
            <div className={`grid gap-x-6 gap-y-4 ${g.title === 'Channels' ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
              {g.ids.filter((id) => id in card).map((id) =>
                field(
                  `rc-${id}`,
                  LONG_LABEL[id] ?? optionLabel(id),
                  card[id]!,
                  (v) => setCard((c) => ({ ...c, [id]: v })),
                  { prefix: '$', hint: g.title === 'Channels' ? `e.g. $150.00 for ${optionLabel(id)}, US, 6 months.` : undefined }
                )
              )}
            </div>
          </div>
        ))}
      </Group>

      <PriceCalculator settings={loaded} />

      <Group title="Autopilot limits" id="g-limits" description="The agent stops and asks you when a quote would go past any of these." tip="autopilot">
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          {field('cap', 'Per-deal cap', caps.perDeal, (v) => setCaps((c) => ({ ...c, perDeal: v })), { prefix: '$', hint: 'A quote above this stops and asks you.' })}
          {field('r30', 'Per-client 30-day cap', caps.rolling30, (v) => setCaps((c) => ({ ...c, rolling30: v })), { prefix: '$', hint: 'A quote above this stops and asks you.' })}
          {field('daily', 'Sends per day', caps.dailyMax, (v) => setCaps((c) => ({ ...c, dailyMax: v })), { inputMode: 'numeric', hint: 'Above this, the agent asks you before sending.' })}
          {field('tz', 'Time zone', timezone, setTimezone, { inputMode: 'text', className: 'sm:col-span-3 sm:max-w-sm', placeholder: 'America/New_York' })}
        </div>
      </Group>

      <Group title="What the agent may sell" id="perm" description="Only “Agent sells on its own” lets the agent invoice without you. Any other choice sends the request to you, and you can still approve it by hand. Exclusive rights always come to you.">
        {issueFor('perm') && <p id="perm-err" className="text-meta text-destructive">{issueFor('perm')}</p>}
        <div className="grid">
          {SELLABLE.map((c) => (
            <fieldset key={c} className="grid gap-2 border-b py-3 last:border-b-0 md:grid-cols-[12rem_minmax(0,1fr)] md:items-center">
              <legend className="sr-only">{LONG_LABEL[c] ?? optionLabel(c)}</legend>
              <span aria-hidden className="text-body font-medium">{LONG_LABEL[c] ?? optionLabel(c)}</span>
              <RadioGroup value={modes[c]} onValueChange={(m) => { setModes((all) => ({ ...all, [c]: m as Mode })); setNotice(null); clearIssues('perm'); }} disabled={busy}
                aria-describedby={issueFor('perm') ? 'perm-err' : undefined}
                className="flex flex-wrap gap-x-6 gap-y-2" aria-label={`${LONG_LABEL[c] ?? optionLabel(c)}`}>
                {(['auto', 'ask', 'off'] as const).filter((m) => c !== 'exclusive' || m !== 'auto').map((m) => (
                  <Label key={m} htmlFor={`mode-${c}-${m}`} className="flex min-h-11 cursor-pointer items-center gap-2 font-normal">
                    <RadioGroupItem id={`mode-${c}-${m}`} value={m} />
                    {MODE_LABEL[m]}
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
          ))}
        </div>
      </Group>

      <Group title="Clients the agent may invoice" id="clients">
        {issueFor('clients') && <p id="clients-err" className="text-meta text-destructive">{issueFor('clients')}</p>}
        {loaded.clients.length === 0 && <p className="text-body text-muted-foreground">No clients yet. Requests will appear in Deals.</p>}
        <div className="grid gap-1">
          {loaded.clients.map((c) => (
            <Label key={c.id} htmlFor={`client-${c.id}`} className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 font-normal">
              <Checkbox id={`client-${c.id}`} checked={allowed.includes(c.id)} disabled={busy} aria-describedby={issueFor('clients') ? 'clients-err' : undefined}
                onCheckedChange={(on) => { setAllowed((a) => (on === true ? [...a, c.id] : a.filter((x) => x !== c.id))); setNotice(null); clearIssues('clients'); }} />
              <span className="text-body font-medium">{c.name}</span>
              <span className="font-mono text-id text-muted-foreground">{c.email}</span>
            </Label>
          ))}
        </div>
      </Group>

      <div className="dash-glass sticky bottom-4 z-10 flex flex-wrap items-center gap-4 rounded-lg border p-3 shadow-popover">
        <Button type="submit" className="h-11 max-md:w-full" disabled={busy || !dirty}>{busy ? 'Saving settings…' : 'Save settings'}</Button>
        <div aria-live="polite" className="text-body">
          {saveError && <p role="alert" className="text-destructive">{saveError}</p>}
          {!saveError && notice && <p role="status">{notice}</p>}
          {!saveError && !notice && dirty && <p className="text-muted-foreground">You have unsaved changes.</p>}
        </div>
      </div>
    </form>
  );
}
