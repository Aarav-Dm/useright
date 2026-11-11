// File access follows scope (spec §2, P1): a paid licence gets the web file;
// print, billboard, out-of-home and TV unlock the largest stored file (print-resolution).
import type { Channel, Scope } from './pricing';

export type FileAccess = { web: 'delivered' | 'locked'; print: 'delivered' | 'locked' };

/** Large-format and broadcast channels unlock the highest stored resolution (the print file), never a smaller web file. */
export const LARGE_FORMAT_CHANNELS: readonly Channel[] = ['print', 'billboard', 'OOH', 'TV'];

export function fileAccess(scope: Scope, paid: boolean): FileAccess {
  const hasLarge = scope.channels.some((c) => (LARGE_FORMAT_CHANNELS as readonly string[]).includes(c));
  return {
    web: paid ? 'delivered' : 'locked',
    print: paid && hasLarge ? 'delivered' : 'locked',
  };
}

export type LicensedFile = { file: 'print' | 'web'; label: string };

/** The licensed file for a scope (batch-6 fix 11): print-resolution when print or large-format is bought, else the web file. Never the original. */
export function licensedFile(scope: Scope): LicensedFile {
  return fileAccess(scope, true).print === 'delivered' ? { file: 'print', label: 'Print-resolution file' } : { file: 'web', label: 'Web file' };
}

/** Storage key of the licensed rendition (F8, F19): the one helper grant, receipts and downloads share. */
export const licensedKey = (file: 'print' | 'web', keys: { key_web: string; key_print: string }) => (file === 'print' ? keys.key_print : keys.key_web);
