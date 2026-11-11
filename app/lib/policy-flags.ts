// Policy flag helper (batch-2 §4). Batch 5 reuses this inside rule R4.
import { CHANNELS } from './pricing';

export type SellableSettings = { autoChannels: readonly string[] };

/** Channel option ids not in the auto-sellable list, plus `exclusive`. Order kept, duplicates dropped. */
export function unsellable(optionIds: readonly string[], settings: SellableSettings): string[] {
  const out: string[] = [];
  for (const id of optionIds) {
    if (out.includes(id)) continue;
    const isChannel = (CHANNELS as readonly string[]).includes(id);
    if (id === 'exclusive' || (isChannel && !settings.autoChannels.includes(id))) out.push(id);
  }
  return out;
}
