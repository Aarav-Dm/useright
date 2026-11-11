import { createHash } from 'node:crypto';

/** JSON with object keys sorted, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
