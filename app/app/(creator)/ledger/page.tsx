'use client';
// /ledger (batch-5 §5, docs/ui/ledger.md): read-only audit of rule decisions, approvals and PayPal results over
// GET /api/ledger. Plain table until the AG Studio grid lands; inline inspection under the row, no money controls.
// Seeded demo rows (`row.demo`) carry a Demo chip and never read as verified PayPal evidence.
import { AlertTriangle, Check, CheckCircle2, ChevronDown, Info, RotateCcw, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CellLabel, DemoChip, EmptyState, LoadError, LoadingRows, PageHeader, STACK, useCopy } from '@/components/creator/page-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ledgerSentence, ruleHeld, ruleTitle } from '@/components/creator/deal-extras';
import { TermTip } from '@/components/creator/explain';
import { shortDate, shortDateTime, usd } from '@/lib/format';
import type { Money, Overview } from '@/lib/overview';
import type { LedgerRow } from '@/lib/ledger';

const NOT_RECORDED = <span aria-label="Not recorded">—</span>;
const COLUMNS = ['When', 'Deal', 'Version', 'Event', 'Result', 'Amount', 'PayPal', ''];
/** Columns that only fit on wide screens (>=1536px); their values stay in the inline detail (Inspect). */
const WIDE_ONLY = new Set(['Version']);

/** The result word for a row, per docs/ui/ledger.md. Verified only for a passed grant that is not demo data. */
function resultLook(row: LedgerRow): { word: string; cls: string; Icon: typeof Check } | null {
  if (!row.result) return null;
  const pass = row.result === 'pass';
  if (row.kind === 'grant' && pass) {
    return row.demo
      ? { word: 'Seeded as paid', cls: 'border-dashed text-muted-foreground', Icon: Check }
      : { word: 'Verified', cls: 'border-success/40 bg-success-bg text-success', Icon: CheckCircle2 };
  }
  if (row.kind === 'grant') return { word: 'Not verified', cls: 'border-warning/50 bg-warning-bg text-warning', Icon: AlertTriangle };
  if (row.kind === 'revoked') return { word: 'Licence revoked', cls: 'border-destructive/40 bg-destructive-bg text-destructive', Icon: RotateCcw };
  if (pass) return { word: 'Pass', cls: 'text-foreground', Icon: Check };
  if (row.kind === 'rule') return { word: 'Stopped', cls: 'border-warning/50 bg-warning-bg text-warning', Icon: AlertTriangle };
  return { word: 'Failed', cls: 'border-destructive/40 bg-destructive-bg text-destructive', Icon: X };
}

function ResultWord({ row }: { row: LedgerRow }) {
  const look = resultLook(row);
  if (!look) return NOT_RECORDED;
  const { Icon } = look;
  return (
    <span className={`inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-label whitespace-nowrap ${look.cls}`}>
      <Icon aria-hidden className="size-3.5" />
      {look.word}
    </span>
  );
}

/** Plain words for the event. Rule rows read "R2 passed" / "R2 stopped, held for your OK" (review final N2: the bell's words); grant and revoke rows use the sheet's words. */
function eventTitle(row: LedgerRow): string {
  if (row.rule) return ruleTitle(row);
  if (row.kind === 'grant') return row.result === 'pass' ? (row.demo ? 'Seeded as paid (demo)' : 'Payment verified, file unlocked') : 'Payment not verified, file locked';
  if (row.kind === 'revoked') return row.demo ? 'Seeded refund (demo)' : 'Licence revoked, downloads stopped';
  return row.label;
}

/** Batch 7C: kind groups for the filter chips. */
const GROUPS: { key: string; label: string; test: (r: LedgerRow) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'rules', label: 'Rules', test: (r) => r.kind === 'rule' },
  { key: 'decisions', label: 'Your decisions', test: (r) => r.kind === 'approved' || r.kind === 'rejected' },
  { key: 'invoices', label: 'Invoices', test: (r) => r.kind.startsWith('invoice.') },
  { key: 'payments', label: 'Payments', test: (r) => r.kind === 'grant' },
  { key: 'refunds', label: 'Refunds and alerts', test: (r) => !['rule', 'approved', 'rejected', 'grant'].includes(r.kind) && !r.kind.startsWith('invoice.') },
];

function MoneyCell({ label, m, kept, partly = 0 }: { label: string; m: Money; kept?: Money; partly?: number }) {
  return (
    <div className="grid gap-1">
      <dt className="text-meta font-medium text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xl font-semibold tabular text-foreground">
        {usd(m.liveCents)} <span className="font-sans text-meta font-normal text-muted-foreground">({m.liveCount})</span>
      </dd>
      {m.demoCount > 0 && <dd className="text-meta text-muted-foreground">plus {usd(m.demoCents)} seeded demo ({m.demoCount})</dd>}
      {/* review B7C-2 finding 1: a cascaded revoke kept its money; it is not counted as refunded. */}
      {kept && kept.liveCount + kept.demoCount > 0 && (
        <dd className="text-meta text-muted-foreground">includes {[kept.liveCount ? usd(kept.liveCents) : null, kept.demoCount ? `${usd(kept.demoCents)} seeded` : null].filter(Boolean).join(' and ')} on licences revoked because an earlier licence was refunded (not paid back)</dd>
      )}
      {partly > 0 && <dd className="text-meta text-muted-foreground">includes {partly} {partly === 1 ? 'payment' : 'payments'} partly refunded in PayPal (the refunded part is not taken off)</dd>}
    </div>
  );
}

type Receipt = { id: string; label: string };

/**
 * review B7C-2 finding 6 / review B7C-2 finding 3: a passed grant row opens its grant receipt and a revoke row its
 * revocation receipt; a failed grant row gets none.
 */
function receiptFor(r: LedgerRow, receipts: Overview['receipts'] | undefined): Receipt | undefined {
  const own = r.versionId ? receipts?.[r.versionId] : undefined;
  if (r.kind === 'revoked' && own?.revocation) return { id: own.revocation, label: 'Open revocation receipt' };
  if (r.kind === 'grant' && r.result === 'pass' && own?.grant) return { id: own.grant, label: 'Open receipt' };
  return undefined;
}

function EventText({ row, receipt }: { row: LedgerRow; receipt?: Receipt }) {
  return (
    <>
      {row.rule
        ? <span className="font-medium"><span className="font-mono">{row.rule}</span> {row.result === 'pass' ? 'passed' : 'stopped'}{row.result !== 'pass' && <span>, {ruleHeld(row.rule)}</span>}</span>
        : <span className="font-medium">{row.label}</span>}
      {(row.kind === 'grant' || row.kind === 'revoked') && <span className="block text-meta">{eventTitle(row)}</span>}
      {row.message && <span className="block text-meta text-muted-foreground">{row.message}</span>}
      {row.kind !== 'rule' && <span className="block text-meta text-muted-foreground">{ledgerSentence(row)}</span>}
      {receipt && <a href={`/r/${receipt.id}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-meta text-foreground underline underline-offset-4">{receipt.label}<span className="sr-only"> (opens in a new tab)</span></a>}
    </>
  );
}

export default function LedgerPage() {
  const router = useRouter();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [group, setGroup] = useState('all');
  const [helpOpen, setHelpOpen] = useState(false);
  // Batch 7C: server totals and receipt ids (read-only GET /api/overview); the page works without them.
  const [overview, setOverview] = useState<Pick<Overview, 'totals' | 'receipts' | 'partlyRefunded'> | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/overview').then(async (r) => {
      if (!r.ok) return;
      const body = await r.json() as Partial<Overview>;
      if (live && body.totals && body.receipts) setOverview({ totals: body.totals, receipts: body.receipts, partlyRefunded: body.partlyRefunded ?? 0 });
    }).catch(() => {});
    return () => { live = false; };
  }, [rows]);
  const [selected, setSelected] = useState<string | null>(null);
  const { note: copyNote, setNote: setCopyNote, copy } = useCopy('Invoice id copied.', 'Couldn’t copy. Select the id to copy it.');
  const inspectRefs = useRef(new Map<string, HTMLButtonElement>());
  const filterRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ledger');
      if (res.status === 401) return router.replace('/login?next=/ledger');
      if (!res.ok) throw new Error(String(res.status));
      setRows((await res.json()).rows);
      setError(null);
    } catch {
      setError('Couldn’t load the ledger. Try again.');
    } finally {
      setLoading(false);
    }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const g = GROUPS.find((x) => x.key === group)!;
    if (!rows) return rows;
    const inGroup = rows.filter(g.test);
    if (!q) return inGroup;
    return inGroup.filter((r) => [r.deal, r.label, r.rule, r.message, r.paypalInvoiceId, r.invoiceNumber, r.paypalTxnId, r.scope]
      .some((v) => v?.toLowerCase().includes(q)));
  }, [rows, filter, group]);

  function open(id: string) {
    setCopyNote(null);
    if (selected === id) return close();
    setSelected(id);
    setTimeout(() => document.getElementById('detail-title')?.focus(), 0);
  }
  function close() {
    const id = selected;
    setSelected(null);
    setCopyNote(null);
    if (id) setTimeout(() => inspectRefs.current.get(id)?.focus(), 0);
  }
  function clearFilter() {
    setFilter('');
    setTimeout(() => filterRef.current?.focus(), 0);
  }

  const detailRow = (d: LedgerRow) => (
    <TableRow className="bg-muted/40 hover:bg-muted/40 max-md:block">
      <TableCell colSpan={COLUMNS.length} className="p-3 whitespace-normal max-md:block">
        <section id="ledger-detail" aria-labelledby="detail-title" className="grid gap-4 rounded-xl border bg-card p-5 shadow-xs">
          <h2 id="detail-title" tabIndex={-1} className="flex flex-wrap items-center gap-2 text-d-section outline-none">
            {eventTitle(d)}
            {d.demo && <DemoChip />}
            <ResultWord row={d} />
            <span className="text-meta font-normal text-muted-foreground">{shortDateTime(d.createdAt)}</span>
          </h2>
          {d.demo && <p className="max-w-prose text-body text-muted-foreground">Demo data seeded for the walkthrough. PayPal never saw this event.</p>}
          {d.message && <p className="max-w-prose text-body">{d.message}</p>}
          <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-[11rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Deal</dt><dd>{d.deal ?? NOT_RECORDED}{d.versionNo ? `, v${d.versionNo}` : ''}</dd>
            <dt className="text-muted-foreground">Scope</dt><dd>{d.scope ?? NOT_RECORDED}</dd>
            <dt className="text-muted-foreground">Amount</dt><dd className="font-mono">{d.amountCents !== null ? usd(d.amountCents) : NOT_RECORDED}</dd>
            <dt className="text-muted-foreground">Invoice number</dt><dd className="font-mono text-id break-all">{d.invoiceNumber ?? NOT_RECORDED}</dd>
            <dt className="text-muted-foreground">{d.demo ? 'Demo invoice id' : 'PayPal invoice id'}</dt><dd className="font-mono text-id break-all">{d.paypalInvoiceId ?? NOT_RECORDED}</dd>
            <dt className="text-muted-foreground">{d.demo ? 'Demo transaction id' : 'PayPal transaction id'}</dt><dd className="font-mono text-id break-all">{d.paypalTxnId ?? NOT_RECORDED}</dd>
            <dt className="text-muted-foreground">Status now</dt><dd>{d.status ?? NOT_RECORDED} <span className="text-meta text-muted-foreground">(current state, not at event time)</span></dd>
            <dt className="text-muted-foreground">Expiry</dt><dd>{d.expiry ? shortDate(d.expiry) : NOT_RECORDED}</dd>
            <dt className="text-muted-foreground">Renewal</dt><dd>{d.renewalDate ? shortDate(d.renewalDate) : NOT_RECORDED}</dd>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            {d.briefId && <Button asChild variant="outline"><Link href={`/deals/${d.briefId}`}>Open deal</Link></Button>}
            {(() => {
              const rc = receiptFor(d, overview?.receipts);
              return rc && <Button asChild variant="ghost"><a href={`/r/${rc.id}`} target="_blank" rel="noreferrer">{rc.label}</a></Button>;
            })()}
            {d.paypalInvoiceId && <Button variant="ghost" onClick={() => void copy(d.paypalInvoiceId!)}>Copy invoice id</Button>}
            <Button variant="ghost" onClick={close}>Close details</Button>
            <p aria-live="polite" className="text-meta text-muted-foreground">{copyNote}</p>
          </div>
        </section>
      </TableCell>
    </TableRow>
  );

  return (
    <section>
      <PageHeader
        title="Ledger"
        description="Every rule decision, approval and PayPal result, newest first. Read-only."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setHelpOpen((o) => !o)}
              aria-expanded={helpOpen}
              aria-controls="ledger-help"
              className="gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <Info aria-hidden className="size-4 shrink-0" />
              What happens here?
              <ChevronDown aria-hidden className={`size-3.5 transition-transform ${helpOpen ? 'rotate-180' : ''}`} />
            </Button>
            <Button variant="outline" onClick={() => void load()} disabled={loading && rows !== null}>
              {loading && rows !== null ? 'Refreshing ledger…' : 'Refresh'}
            </Button>
          </div>
        }
      />
      <Collapsible open={helpOpen} onOpenChange={setHelpOpen} className="mb-6">
        <CollapsibleContent id="ledger-help" className="rounded-md border bg-card p-4 text-body text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
          <div className="grid max-w-prose gap-2">
            <p>Every decision the agent made and everything PayPal reported, newest first. Nothing here can be changed.</p>
            <p>Rule rows show R1 to R5 for each quote. Invoice rows show what was sent to PayPal. <strong>Verified</strong> means PayPal confirmed the payment and the file was unlocked; <strong>Licence revoked</strong> means the payment was refunded and downloads stopped.</p>
            <p>Rows marked <strong>Demo</strong> were seeded for the walkthrough; PayPal never saw them. Use <strong>Inspect</strong> to see every id on a row.</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {error && <LoadError message={error} onRetry={() => void load()} retrying={loading} />}
      {rows === null && !error && <LoadingRows label="Loading agent decisions and PayPal events…" rows={6} height="h-12" />}
      {rows?.length === 0 && <EmptyState>No agent activity yet. Add a request to see its checks here.</EmptyState>}

      {rows && rows.length > 0 && (
        <>
          {overview && (
            <dl aria-label="Totals" className="mb-6 grid gap-3 sm:grid-cols-3">
              <Card className="py-4">
                <CardContent className="px-4">
                  <MoneyCell label="Earned (PayPal-verified)" m={overview.totals.earned} kept={overview.totals.revokedKept} partly={overview.partlyRefunded} />
                </CardContent>
              </Card>
              <Card className="py-4">
                <CardContent className="px-4">
                  <MoneyCell label="Waiting for payment" m={overview.totals.pending} />
                </CardContent>
              </Card>
              <Card className="py-4">
                <CardContent className="px-4">
                  <MoneyCell label="Refunded" m={overview.totals.refunded} />
                </CardContent>
              </Card>
            </dl>
          )}
          <div role="group" aria-label="Show events" className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-label text-muted-foreground">Show</span>
            {GROUPS.map((g) => (
              <Button key={g.key} size="sm" variant={group === g.key ? 'secondary' : 'ghost'} aria-pressed={group === g.key} className="h-9 gap-2 rounded-full border" onClick={() => setGroup(g.key)}>
                {g.label}{' '}<span className="font-mono text-meta text-muted-foreground">{rows.filter(g.test).length}</span>
              </Button>
            ))}
            <TermTip term="ledger" />
          </div>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="ledger-filter">Filter by deal, event or id</Label>
              <Input ref={filterRef} id="ledger-filter" className="h-10 w-72 max-w-full" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Northwind, R2, INV2-…" />
            </div>
            {filter && <Button variant="ghost" onClick={clearFilter}>Clear</Button>}
            <p className="text-meta text-muted-foreground">{shown!.length} of {rows.length} events</p>
          </div>

          {shown!.length === 0 ? (
            <EmptyState action={<Button variant="outline" onClick={clearFilter}>Clear</Button>}>No events match these filters.</EmptyState>
          ) : (
            <Card className="py-0 overflow-hidden border">
              <Table className="text-body!">
                <TableCaption className="sr-only">Ledger events, newest first</TableCaption>
                <TableHeader className="max-md:sr-only">
                  <TableRow className="hover:bg-transparent">
                    {COLUMNS.map((h, i) => (
                      <TableHead key={i} className={`h-10 px-3 text-meta font-medium text-muted-foreground ${h === 'Amount' ? 'text-right' : ''} ${WIDE_ONLY.has(h) ? 'max-2xl:hidden' : ''}`}>
                        {h || <span className="sr-only">Details</span>}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown!.map((r) => (
                    <Fragment key={r.eventId}>
                      <TableRow data-state={selected === r.eventId ? 'selected' : undefined}
                        className="max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-4 max-md:gap-y-1.5 max-md:py-4">
                        <TableCell className={`px-3 py-3 align-top whitespace-nowrap text-muted-foreground max-md:text-meta ${STACK}`}>
                          <time dateTime={new Date(r.createdAt).toISOString()}>{shortDateTime(r.createdAt)}</time>
                        </TableCell>
                        <TableCell className={`min-w-44 px-3 py-3 align-top whitespace-normal max-md:col-span-2 ${STACK}`}>
                          {/* B16: client on one line, photo under it, instead of one string wrapping over three lines. */}
                          {r.briefId ? <Link href={`/deals/${r.briefId}`} className="grid underline-offset-4 hover:underline">{(() => { const [who, ...what] = (r.deal ?? 'deal').split(' · '); return <><span className="font-medium">{who}{what.length ? <span className="sr-only"> · </span> : null}</span>{what.length > 0 && <span className="text-meta text-muted-foreground">{what.join(' · ')}</span>}</>; })()}</Link> : NOT_RECORDED}
                        </TableCell>
                        <TableCell className={`px-3 py-3 align-top font-mono text-id max-2xl:hidden ${STACK}`}>{r.versionNo ? `v${r.versionNo}` : NOT_RECORDED}</TableCell>
                        <TableCell className={`max-w-sm min-w-56 px-3 py-3 align-top whitespace-normal max-md:col-span-2 max-md:max-w-none ${STACK}`}><EventText row={r} receipt={receiptFor(r, overview?.receipts)} /></TableCell>
                        <TableCell className={`px-3 py-3 align-top ${STACK}`}>
                          <span className="inline-flex flex-wrap items-center gap-1.5"><ResultWord row={r} />{r.demo && <DemoChip />}</span>
                        </TableCell>
                        <TableCell className={`px-3 py-3 text-right align-top font-mono text-id tabular max-md:text-left ${STACK}`}>
                          <CellLabel>Amount</CellLabel>{r.amountCents !== null ? <span>{usd(r.amountCents)}</span> : NOT_RECORDED}
                        </TableCell>
                        <TableCell className={`px-3 py-3 align-top font-mono text-id whitespace-nowrap max-md:break-all max-md:whitespace-normal ${STACK}`}>
                          {r.paypalInvoiceId && <span className="block">{r.paypalInvoiceId}</span>}
                          {r.paypalTxnId && <span className="block text-meta text-muted-foreground">{r.paypalTxnId}</span>}
                          {r.status && <span className="mt-1 block"><Badge variant="outline" className="text-xs">{r.status}</Badge></span>}
                          {!r.paypalInvoiceId && !r.paypalTxnId && !r.status && NOT_RECORDED}
                        </TableCell>
                        <TableCell className={`px-3 py-2 align-top max-md:col-span-2 ${STACK}`}>
                          <Button
                            ref={(el) => { if (el) inspectRefs.current.set(r.eventId, el); }}
                            variant="ghost" size="sm" aria-expanded={selected === r.eventId} aria-controls={selected === r.eventId ? 'ledger-detail' : undefined}
                            onClick={() => open(r.eventId)}
                          >
                            {selected === r.eventId ? 'Close details' : 'Inspect'}
                            <span className="sr-only"> event from {shortDateTime(r.createdAt)}</span>
                          </Button>
                        </TableCell>
                      </TableRow>
                      {selected === r.eventId && detailRow(r)}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}
    </section>
  );
}
