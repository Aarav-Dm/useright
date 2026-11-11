// Licence and price column of the deal room (docs/ui/deal-room.md). Render-only: every value is from the read model.
import { evidenceRefs } from '@/components/creator/evidence';
import { TermTip } from '@/components/creator/explain';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { BriefView } from '@/lib/briefs';
import { optionLabel, renewalInvoiceDay, scopeParts, shortDate, usd } from '@/lib/format';

export function LicenceCard({ licence }: { licence: BriefView['licence'] }) {
  if (!licence) return <p className="text-body text-muted-foreground">No licence yet (v1). The price is the full scope at your current rate card.</p>;
  const { scope } = licence;
  const row = 'grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 py-1.5';
  return (
    <dl className="grid text-body">
      <div className={row}><dt className="text-muted-foreground">Version</dt><dd>v{licence.versionNo} ({licence.status})</dd></div>
      <div className={row}><dt className="text-muted-foreground">Channels</dt><dd>{scope.channels.map(optionLabel).join(', ') || '—'}</dd></div>
      <div className={row}><dt className="text-muted-foreground">Territory</dt><dd>{optionLabel(scope.territory)}</dd></div>
      <div className={row}><dt className="text-muted-foreground">Term</dt><dd>{scope.durationMonths} months{scope.exclusive ? ', exclusive' : ''}</dd></div>
      <div className={row}><dt className="text-muted-foreground">Runs</dt><dd>{shortDate(licence.startAt)} to {shortDate(licence.endAt)}</dd></div>
      <div className={row}><dt className="text-muted-foreground">Paid</dt><dd className="font-mono tabular">{usd(licence.paidCents)}</dd></div>
      {/* Batch 8 §4: what happens at the end of the term. */}
      {licence.endAt && licence.renewalOptIn !== undefined && (
        <div className={row}>
          <dt className="flex items-center gap-1 text-muted-foreground">Renewal <TermTip term="renewal" /></dt>
          <dd>
            {licence.renewalSent ? 'Renewal sent'
              : licence.renewalOptIn ? `Renewal invoice from ${shortDate(renewalInvoiceDay(licence.endAt))}; ends ${shortDate(licence.endAt)} unless paid`
                : `Not requested; ends ${shortDate(licence.endAt)} unless you renew it`}
          </dd>
        </div>
      )}
    </dl>
  );
}

/** Current -> Requested, added options marked, and the sum the total comes from. Every value is from the read model. */
export function ScopeComparison({ gap, renewing = null }: { gap: NonNullable<BriefView['gapPreview']>; renewing?: BriefView['renewalParent'] }) {
  const added = new Set(renewing ? [] : gap.newOptionIds);
  const current = renewing?.scope ?? gap.current;
  const parts = (scope: typeof gap.combined, mark: boolean) => {
    const channels: readonly string[] = scope.channels;
    return scopeParts(scope).map((p, i, all) => {
      // Channels join with " + ", the rest with ", ".
      const prev = all[i - 1];
      const sep = !prev ? '' : channels.includes(prev.id) && channels.includes(p.id) ? ' + ' : ', ';
      return (
        <span key={p.id}>
          {sep}
          {mark && added.has(p.id) ? <mark className="rounded-sm bg-transparent px-0.5 font-semibold text-added underline decoration-2 underline-offset-4">{p.label}</mark> : p.label}
        </span>
      );
    });
  };
  return (
    <div className="grid gap-2 text-body">
      <dl className="grid gap-1">
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4">
          <dt className="text-muted-foreground">Current</dt>
          <dd>{current ? parts(current, false) : 'No licence yet'}</dd>
        </div>
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4">
          <dt className="text-muted-foreground">Requested</dt>
          <dd>{parts(gap.combined, true)}</dd>
        </div>
      </dl>
      <p className="font-mono text-id text-muted-foreground tabular">
        {gap.paidCents > 0
          ? `combined price ${usd(gap.combinedCents)} - ${usd(gap.paidCents)} already paid = ${usd(gap.totalCents)} due`
          : `price ${usd(gap.combinedCents)} = ${usd(gap.totalCents)} due`}
      </p>
    </div>
  );
}

export function GapTable({ view }: { view: BriefView }) {
  const g = view.gapPreview;
  const suggested = view.extraction?.suggested_price_cents;
  const refs = evidenceRefs(view);
  return (
    <div className="grid gap-4">
      {g && <ScopeComparison gap={g} renewing={view.renewalParent} />}
      {!g && (
        <p className="text-body">
          <span className="font-medium">No price yet.</span>{' '}
          <span className="text-muted-foreground">
            {view.status === 'awaiting_verification' ? 'It is priced once the requester confirms their email.'
              : view.status === 'awaiting_transcript' ? 'It is priced once you confirm the transcript.'
              : view.status === 'clarify' ? 'It is priced once the client answers the question above.'
              : 'Resolve the points above first.'}
          </span>
        </p>
      )}
      {g && (
        <Table className="text-body!">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-9 px-0 text-meta font-medium text-muted-foreground">Option</TableHead>
              <TableHead className="h-9 text-meta font-medium text-muted-foreground">Source</TableHead>
              <TableHead className="h-9 px-0 text-right text-meta font-medium text-muted-foreground">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {g.lines.map((l) => {
              const ref = refs.get(l.optionId);
              return (
                <TableRow key={l.optionId} className="hover:bg-transparent">
                  <TableCell className="px-0 py-2 whitespace-normal">
                    {optionLabel(l.optionId)}
                    {!view.renewalParent && g.newOptionIds.includes(l.optionId) ? <span className="ml-2 text-meta font-medium text-added">new</span> : null}
                    {ref && (
                      <a
                        href={`#${ref.anchor}`}
                        className="relative ml-2 inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm border px-1 font-mono text-[0.6875rem] text-added underline-offset-2 before:absolute before:-inset-2.5 before:content-[''] hover:underline"
                        aria-label={`Source sentence ${ref.n} for ${optionLabel(l.optionId)}`}
                      >
                        {ref.n}
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="py-2 whitespace-normal text-muted-foreground">{l.optionId === 'credit:paid' ? `paid on v${view.licence?.versionNo ?? 1}` : 'rate card'}</TableCell>
                  <TableCell className="px-0 py-2 text-right font-mono tabular">{usd(l.cents)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter className="bg-transparent">
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={2} className="px-0 pt-4 align-bottom font-medium whitespace-normal">Amount due{g.refused ? ' (nothing new to sell; no charge)' : ''}</TableCell>
              <TableCell className="px-0 pt-4 text-right font-mono text-money">{usd(g.totalCents)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      )}
      {suggested != null && (
        <p className="text-body text-muted-foreground">
          <s className="font-mono tabular">{usd(suggested)}</s> AI suggestion, ignored. Your rate card sets every dollar.
        </p>
      )}
    </div>
  );
}
