'use client';
// Creator edits in the deal room (batch-4 §3, fix 2): change client/asset, remove a use, add one backed by a client sentence.
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { BriefView } from '@/lib/briefs';
import { sentenceSpans } from '@/lib/checks';
import { optionLabel } from '@/lib/format';

export type Options = { clients: { id: string; name: string }[]; assets: { id: string; title: string }[]; optionIds: string[] };
export type Edit = { clientId?: string; assetId?: string; uses?: { optionId: string; quote: string }[] };

export function DealSetup({ view, options, onEdit, busy }: { view: BriefView; options: Options | null; onEdit: (e: Edit) => void; busy: boolean }) {
  const [addOption, setAddOption] = useState('');
  const [addQuote, setAddQuote] = useState('');
  const kept = view.checks?.kept ?? [];
  // review 5: the server decides (false while an invoice is out); screens never derive it.
  const editable = view.editable;

  // Quotes the creator may pick: every sentence of every client line, as written.
  const sentences = useMemo(() => {
    const out: string[] = [];
    for (const l of view.transcript?.lines ?? []) {
      if (l.speaker !== 'client') continue;
      for (const s of sentenceSpans(l.text)) {
        const t = l.text.slice(s.start, s.end);
        if (t.length >= 12 && !out.includes(t)) out.push(t);
      }
    }
    return out;
  }, [view.transcript]);

  const asUses = (list: typeof kept) => list.map((k) => ({ optionId: k.optionId, quote: k.quote }));

  return (
    <div className="grid max-w-3xl gap-6 text-body">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="setup-client">Client</Label>
          <Select value={view.client?.id ?? ''} onValueChange={(v) => onEdit({ clientId: v })} disabled={busy || !editable}>
            <SelectTrigger id="setup-client" className="h-11 w-full"><SelectValue placeholder="Unknown sender: pick a client" /></SelectTrigger>
            <SelectContent>{options?.clients.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="setup-photo">Photo</Label>
          <Select value={view.asset?.id ?? ''} onValueChange={(v) => onEdit({ assetId: v })} disabled={busy || !editable}>
            <SelectTrigger id="setup-photo" className="h-11 w-full"><SelectValue placeholder="Pick the photo" /></SelectTrigger>
            <SelectContent>{options?.assets.map((a) => <SelectItem key={a.id} value={a.id}>{a.title}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-1.5">
        <p className="text-label">Requested uses</p>
        {kept.length === 0 && <p className="text-muted-foreground">None yet.</p>}
        <ul className="grid gap-1">
          {kept.map((k) => (
            <li key={k.optionId} className="flex items-start justify-between gap-3 border-b py-2 last:border-b-0">
              <span><Badge variant="outline">{optionLabel(k.optionId)}</Badge> <span className="text-muted-foreground">&ldquo;{k.quote}&rdquo;</span></span>
              <Button size="sm" variant="ghost" disabled={busy || !editable} onClick={() => onEdit({ uses: asUses(kept.filter((x) => x.optionId !== k.optionId)) })}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      </div>

      {editable && (
        <form
          className="grid gap-3 rounded-md border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            onEdit({ uses: [...asUses(kept.filter((x) => x.optionId !== addOption)), { optionId: addOption, quote: addQuote }] });
            setAddOption('');
            setAddQuote('');
          }}
        >
          <p className="text-label">Add a use</p>
          <p className="text-muted-foreground">Every use needs the client sentence that asks for it.</p>
          <Select value={addOption} onValueChange={setAddOption}>
            <SelectTrigger className="w-48" aria-label="Option to add"><SelectValue placeholder="Option" /></SelectTrigger>
            <SelectContent>{options?.optionIds.map((id) => <SelectItem key={id} value={id}>{optionLabel(id)}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={addQuote} onValueChange={setAddQuote}>
            <SelectTrigger aria-label="Client sentence"><SelectValue placeholder="Client sentence that asks for it" /></SelectTrigger>
            <SelectContent>{sentences.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
          </Select>
          <Button type="submit" variant="outline" className="w-fit" disabled={busy || !addOption || !addQuote}>Add use</Button>
        </form>
      )}
    </div>
  );
}
