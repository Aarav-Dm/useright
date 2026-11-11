'use client';
// Source column of the deal room (docs/ui/deal-room.md): the client's words, with each kept use's exact sentence
// highlighted and numbered. The same number appears on the price line that use pays for (evidence reference).
import { useEffect, useState, type ReactNode } from 'react';
import { evidenceRefs, type EvidenceRef } from '@/components/creator/evidence';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { TranscriptLine } from '@/lib/ai/types';
import type { BriefView } from '@/lib/briefs';
import { normalise, sentenceSpans } from '@/lib/checks';
import { optionLabel } from '@/lib/format';

type Refs = Map<string, EvidenceRef>;

const SPEAKER_LABEL: Record<TranscriptLine['speaker'], string> = { client: 'Client', creator: 'You', unknown: 'Unknown' };

/**
 * One line with its kept sentences highlighted. A sentence the client repeats in the same line is highlighted
 * once (the first occurrence, which is the one the checks matched), so every evidence id is unique.
 */
function Highlighted({ text, marks, refs }: { text: string; marks: Map<string, string[]>; refs: Refs }) {
  const out: ReactNode[] = [];
  const done = new Set<string>();
  let at = 0;
  for (const { start, end } of sentenceSpans(text)) {
    const sentence = normalise(text.slice(start, end));
    const ids = marks.get(sentence);
    if (!ids || done.has(sentence)) continue;
    done.add(sentence);
    const anchor = refs.get(ids[0]!)?.anchor;
    out.push(<span key={`t${at}`}>{text.slice(at, start)}</span>);
    out.push(
      <mark
        key={`m${start}`}
        id={anchor}
        tabIndex={-1}
        className="rounded-sm bg-highlight px-0.5 text-highlight-foreground outline-none target:ring-2 target:ring-ring target:ring-offset-2 target:ring-offset-background focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
      >
        {text.slice(start, end)}
        {ids.map((id) => (
          <span key={id} className="ml-1 inline-flex items-center gap-1 rounded-sm border border-current/30 px-1 align-middle font-mono text-[0.6875rem] leading-4 font-medium">
            {refs.get(id) ? <span aria-hidden className="mr-0.5 border-r border-current/30 pr-1">{refs.get(id)!.n}</span> : null}
            <span className="sr-only">Source for </span>
            {optionLabel(id)}
          </span>
        ))}
      </mark>,
    );
    at = end;
  }
  out.push(<span key="rest">{text.slice(at)}</span>);
  return <span className="whitespace-pre-line">{out}</span>;
}

export function TranscriptPanel({ view, onConfirm, busy }: { view: BriefView; onConfirm: (lines: TranscriptLine[]) => void; busy: boolean }) {
  const [lines, setLines] = useState<TranscriptLine[]>(view.transcript?.lines ?? []);
  // Batch 7C: the same confirmed lines as a conversation (client left, you right). The list stays the default.
  const [asChat, setAsChat] = useState(false);
  useEffect(() => setLines(view.transcript?.lines ?? []), [view.transcript]);
  const confirmed = !!view.transcript?.confirmed_at;
  const waiting = view.brief.state === 'awaiting_verification';
  const refs = evidenceRefs(view);

  const marks = new Map<number, Map<string, string[]>>();
  for (const k of view.checks?.kept ?? []) {
    const m = marks.get(k.lineIndex) ?? new Map<string, string[]>();
    m.set(k.sentence, [...(m.get(k.sentence) ?? []), k.optionId]);
    marks.set(k.lineIndex, m);
  }
  const setLine = (i: number, patch: Partial<TranscriptLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="grid gap-4">
      {view.brief.hasImage && (
        <figure className="grid gap-2">
          <img src={`/api/briefs/${view.brief.id}/image`} alt="The client's message, as sent" className="max-h-[22.5rem] w-fit rounded-md border object-contain" />
          <figcaption className="text-meta text-muted-foreground">Screenshot as received</figcaption>
        </figure>
      )}
      {waiting && <p className="text-body text-muted-foreground">The requester has not confirmed their email yet. Nothing is read until they do.</p>}
      {!confirmed && !waiting && lines.length > 0 && (
        <p className="text-body">Check who said what, then confirm. Confirming may send an invoice within your limits. Only the client&apos;s lines are read for uses.</p>
      )}
      {(confirmed || waiting) && lines.length > 0 && (
        <div role="group" aria-label="Show the message as" className="flex gap-1">
          {([[false, 'List'], [true, 'Conversation']] as const).map(([chat, label]) => (
            <Button key={label} type="button" size="sm" variant={asChat === chat ? 'secondary' : 'ghost'} aria-pressed={asChat === chat} className="h-8 rounded-full border" onClick={() => setAsChat(chat)}>
              {label}
            </Button>
          ))}
        </div>
      )}
      {asChat && (confirmed || waiting) ? (
        <ol className="grid gap-2" aria-label="Conversation">
          {lines.map((l, i) => (
            <li key={i} className={`flex ${l.speaker === 'creator' ? 'justify-end' : 'justify-start'}`}>
              <div className={`grid max-w-[85%] gap-1 rounded-lg border px-3 py-2 ${l.speaker === 'creator' ? 'bg-secondary' : 'bg-card'}`}>
                <span className="text-meta font-medium text-muted-foreground">{SPEAKER_LABEL[l.speaker]}</span>
                <p className="text-body"><Highlighted text={l.text} marks={marks.get(i) ?? new Map()} refs={refs} /></p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
      <ol className="grid gap-3">
        {lines.map((l, i) => (
          <li key={i} className={`grid gap-1 ${l.speaker === 'client' ? '' : 'text-muted-foreground'}`}>
            {confirmed || waiting ? (
              <>
                <span className="text-meta font-medium text-muted-foreground">{SPEAKER_LABEL[l.speaker]}</span>
                <p className="max-w-prose text-body"><Highlighted text={l.text} marks={marks.get(i) ?? new Map()} refs={refs} /></p>
              </>
            ) : (
              <div className="grid gap-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor={`speaker-${i}`} className="text-meta! text-muted-foreground">Line {i + 1}</Label>
                  <Select value={l.speaker} onValueChange={(v) => setLine(i, { speaker: v as TranscriptLine['speaker'] })}>
                    <SelectTrigger id={`speaker-${i}`} className="h-9 w-32" aria-label={`Speaker of line ${i + 1}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="client">client</SelectItem>
                      <SelectItem value="creator">creator</SelectItem>
                      <SelectItem value="unknown">unknown</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Textarea rows={2} value={l.text} aria-label={`Text of line ${i + 1}`} onChange={(e) => setLine(i, { text: e.target.value })} />
              </div>
            )}
          </li>
        ))}
      </ol>
      )}
      {!confirmed && !waiting && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setLines([...lines, { speaker: 'client', text: '' }])}>Add a line</Button>
          {lines.length > 0 && (
            <Button onClick={() => onConfirm(lines.filter((l) => l.text.trim()))} disabled={busy || !lines.some((l) => l.text.trim())}>
              {busy ? 'Reading the confirmed transcript…' : 'Confirm transcript'}
            </Button>
          )}
        </div>
      )}
      {(view.checks?.dropped.length ?? 0) > 0 && (
        <div className="grid gap-1 border-t pt-3">
          <p className="text-meta font-medium text-muted-foreground">Dropped by the checks</p>
          <ul className="grid gap-1 text-body text-muted-foreground">
            {view.checks!.dropped.map((d, i) => (
              <li key={i}><s>{optionLabel(d.optionId)}</s>: &ldquo;{d.quote}&rdquo; <code className="font-mono text-id">({d.reason})</code></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
