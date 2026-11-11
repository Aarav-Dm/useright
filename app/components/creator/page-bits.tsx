'use client';
// Shared dashboard pieces (docs/ui/README.md): status words with an icon, page header, loading rows, load errors.
// Status colour follows the README: warning for stops that need the creator, success only for PayPal-verified
// payment, destructive for failure/refund, neutral for everything else. Words always carry the meaning.
import {
  AlertTriangle, Ban, CalendarX2, CheckCircle2, CircleDashed, Clock, FileSearch, FlaskConical, Loader2, MailQuestion, RotateCcw, Send, XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusTip } from '@/components/creator/explain';
import { STATUS_LABEL } from '@/lib/format';

type Tone = 'neutral' | 'warning' | 'success' | 'danger';

const STATUS_LOOK: Record<string, { tone: Tone; icon: LucideIcon }> = {
  ready: { tone: 'neutral', icon: FileSearch },
  needs_creator: { tone: 'warning', icon: AlertTriangle },
  clarify: { tone: 'warning', icon: MailQuestion },
  awaiting_verification: { tone: 'neutral', icon: Clock },
  awaiting_transcript: { tone: 'neutral', icon: Clock },
  needs_approval: { tone: 'warning', icon: AlertTriangle },
  sending: { tone: 'neutral', icon: Loader2 },
  invoiced: { tone: 'neutral', icon: Send },
  failed: { tone: 'danger', icon: XCircle },
  cancelled: { tone: 'neutral', icon: Ban },
  rejected: { tone: 'neutral', icon: Ban },
  paid: { tone: 'success', icon: CheckCircle2 },
  refunded: { tone: 'danger', icon: RotateCcw },
  expired: { tone: 'neutral', icon: CalendarX2 },
};

const TONE_VARIANT = { neutral: 'outline', warning: 'warning', success: 'success', danger: 'danger' } as const;

/** Demo deals never get the success treatment: a seeded payment is not a PayPal payment. */
const DEMO_LABEL: Record<string, string> = { paid: 'Seeded as paid', refunded: 'Seeded as refunded' };

export function StatusBadge({ status, demo = false, hardBlock = false, paidUse = false }: { status: string; demo?: boolean; hardBlock?: boolean; paidUse?: boolean }) {
  const base = STATUS_LOOK[status] ?? { tone: 'neutral' as const, icon: CircleDashed };
  const look = demo && base.tone === 'success' ? { ...base, tone: 'neutral' as const } : base;
  const Icon = look.icon;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant={TONE_VARIANT[look.tone]} className="h-6 gap-1.5 rounded-md px-2 text-label! font-medium">
        <Icon aria-hidden className={`size-3.5 ${status === 'sending' ? 'motion-safe:animate-spin' : ''}`} />
        {(demo && DEMO_LABEL[status]) || STATUS_LABEL[status] || status}
      </Badge>
      {demo && <DemoChip />}
      <StatusTip status={status} demo={demo} hardBlock={hardBlock} paidUse={paidUse} />
    </span>
  );
}

/** Marks seeded walkthrough data wherever it could be mistaken for PayPal evidence. */
export function DemoChip() {
  return (
    <Badge variant="outline" className="h-6 gap-1 rounded-md border-dashed px-2 text-label! font-medium text-muted-foreground">
      <FlaskConical aria-hidden className="size-3.5" />
      Demo
    </Badge>
  );
}

/** Stacks a table cell into a block below 768px (same DOM, same order). */
export const STACK = 'max-md:block max-md:border-0 max-md:p-0';

/** Visible label for a stacked cell on small screens (the header row is hidden there). */
export function CellLabel({ children }: { children: ReactNode }) {
  return <span className="mr-1 font-sans text-meta text-muted-foreground md:hidden">{children}</span>;
}

/** Clipboard copy that reports only what actually happened (F17). */
export function useCopy(copied: string, failed = 'Couldn’t copy. Select the text to copy it.') {
  const [note, setNote] = useState<string | null>(null);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNote(copied);
    } catch {
      setNote(failed);
    }
  }
  return { note, setNote, copy };
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="grid gap-1">
        <h1 className="text-d-page">{title}</h1>
        {description && <p className="text-body text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Neutral placeholder rows with a status line; no invented content. */
export function LoadingRows({ label, rows = 4, height = 'h-14' }: { label: string; rows?: number; height?: string }) {
  return (
    <div className="grid gap-2" aria-busy="true">
      <p role="status" className="text-body text-muted-foreground">{label}</p>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className={`${height} w-full rounded-md`} />)}
    </div>
  );
}

/** A load failure above whatever is already on screen, with a retry that shows it is running. */
export function LoadError({ message, onRetry, retrying = false }: { message: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <Alert variant="destructive" className="mb-4">
      <XCircle aria-hidden />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3 text-body">
        <span>{message}</span>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Trying again…' : 'Try again'}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** One teaching line for an empty list, plus an optional next action. */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-3 border-y py-8">
      <p className="max-w-prose text-body text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}
