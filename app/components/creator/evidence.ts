// Evidence references (docs/ui/deal-room.md): pure projection of the checks' kept uses, shared by the source column
// and the price table. No React, no client-only code.
import type { BriefView } from '@/lib/briefs';

export type EvidenceRef = { n: number; anchor: string };

/**
 * One number per kept use, in the order the checks kept them. `anchor` is the element id of the highlighted
 * sentence (shared when one sentence backs several uses). An option with no kept sentence has no entry, so its
 * price line gets no link.
 */
export function evidenceRefs(view: BriefView): Map<string, EvidenceRef> {
  const refs = new Map<string, EvidenceRef>();
  const anchors = new Map<string, string>();
  for (const k of view.checks?.kept ?? []) {
    if (refs.has(k.optionId)) continue;
    const n = refs.size + 1;
    const key = `${k.lineIndex}:${k.sentence}`;
    if (!anchors.has(key)) anchors.set(key, `evidence-${n}`);
    refs.set(k.optionId, { n, anchor: anchors.get(key)! });
  }
  return refs;
}
