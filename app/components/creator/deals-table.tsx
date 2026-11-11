'use client';
// Deals list body (batch-4 §2, docs/ui/deals.md). Pure: renders rows it is given, including deals with no price yet.
// One table: at >=768px a dense table; below it each row stacks into a labelled block (same DOM, same order).
import Link from 'next/link';
import { DealProgress, STATUS_MEANING } from '@/components/creator/explain';
import { CellLabel, STACK, StatusBadge } from '@/components/creator/page-bits';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DealRow } from '@/lib/deals';
import { SOURCE_LABEL, shortDate, usd, waitingAge } from '@/lib/format';
import { describeReason, hasPaidUse } from '@/lib/reasons';

export const NO_PRICE = 'No price yet';

/** A finished deal owes nothing more; its amount column says what happened instead of a stale gap preview. */
const SETTLED: Record<string, string> = { paid: 'Paid', refunded: 'Refunded', rejected: 'Not charged', cancelled: 'Not charged' };

export function DealsTable({ deals, onOpen, waiting = false }: { deals: DealRow[]; onOpen?: (briefId: string) => void; /** B9 9.4: the Needs you view, oldest first with its waiting age. */ waiting?: boolean }) {
  return (
    <Table className="text-body!">
      <TableCaption className="sr-only">{waiting ? 'Usage requests that need you, oldest first' : 'Usage requests, newest first'}</TableCaption>
      <TableHeader className="max-md:sr-only">
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-10 px-4 text-meta font-medium text-muted-foreground">Client and photo</TableHead>
          <TableHead className="h-10 px-4 text-meta font-medium text-muted-foreground">Source</TableHead>
          <TableHead className="h-10 px-4 text-meta font-medium text-muted-foreground">State</TableHead>
          <TableHead className="h-10 px-4 text-meta font-medium text-muted-foreground">Why</TableHead>
          <TableHead className="h-10 px-4 text-right text-meta font-medium text-muted-foreground">Due</TableHead>
          <TableHead className="h-10 px-4 text-meta font-medium text-muted-foreground">Received</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deals.map((d) => (
          <TableRow
            key={d.briefId}
            data-needs-you={STATUS_MEANING[d.status]?.needsYou ? '' : undefined}
            className={`max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-4 max-md:gap-y-2 max-md:py-4 data-[needs-you]:bg-warning-bg/50 ${onOpen ? 'cursor-pointer' : ''}`}
            onClick={onOpen ? () => onOpen(d.briefId) : undefined}
          >
            <TableCell className={`min-w-60 px-4 py-3 align-top whitespace-normal ${STACK}`}>
              <Link href={`/deals/${d.briefId}`} className="text-body font-medium underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>
                {d.client?.name ?? 'Unknown sender'}
              </Link>
              <span className="block text-meta text-muted-foreground">{d.asset?.title ?? 'No photo picked'}</span>
              <span className="hidden text-meta text-muted-foreground max-md:block">{SOURCE_LABEL[d.source] ?? d.source}</span>
            </TableCell>
            <TableCell className="px-4 py-3 align-top text-muted-foreground max-md:hidden">
              <CellLabel>From</CellLabel><span>{SOURCE_LABEL[d.source] ?? d.source}</span>
            </TableCell>
            <TableCell className={`px-4 py-3 align-top max-md:order-3 ${STACK}`}><StatusBadge status={d.status} demo={d.demo} paidUse={hasPaidUse(d.reasons)} /><DealProgress status={d.status} /></TableCell>
            <TableCell className={`max-w-xs px-4 py-3 align-top whitespace-normal text-muted-foreground max-md:order-5 max-md:col-span-2 max-md:max-w-none ${STACK}`}>
              {d.reasons[0] ? <span className="line-clamp-2" title={describeReason(d.reasons[0])}>{describeReason(d.reasons[0])}</span> : <span aria-label="No reason">—</span>}
            </TableCell>
            <TableCell className={`w-28 px-4 py-3 text-right align-top font-mono text-id tabular max-md:pr-6! max-md:order-2 max-md:row-start-1 max-md:col-start-2 max-md:text-label ${STACK}`}>
              <CellLabel>Due</CellLabel>
              {SETTLED[d.status]
                ? <span className="font-sans text-muted-foreground">{SETTLED[d.status]}</span>
                : d.gapTotalCents === null ? <span className="font-sans text-muted-foreground">{NO_PRICE}</span> : <span>{usd(d.gapTotalCents)}</span>}
            </TableCell>
            <TableCell className={`px-4 py-3 align-top whitespace-nowrap text-muted-foreground max-md:order-6 max-md:text-meta ${STACK}`}>
              <CellLabel>Received</CellLabel>
              <time dateTime={new Date(d.createdAt).toISOString()}>{shortDate(d.createdAt)}</time>
              {waiting && <span className="block text-meta text-warning">{waitingAge(d.createdAt)}</span>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
