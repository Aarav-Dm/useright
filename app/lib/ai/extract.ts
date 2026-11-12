// One AI adapter (batch-3 §2): transcribe(image) and extract(transcript, assetHint).
// AI_PROVIDER = gemini | openai_compat | fixture. JSON only, validated with zod, one retry, then ai_invalid.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { EXTRACT_SYSTEM, extractUserMessage, TRANSCRIBE_SYSTEM, TRANSCRIBE_USER } from './prompts';
import {
  ExtractionSchema,
  TranscriptSchema,
  type AiResult,
  type Extraction,
  type ImageInput,
  type Transcript,
} from './types';

export type CallKind = 'transcribe' | 'extract';
export type ProviderRequest = { kind: CallKind; system: string; user: string; image?: ImageInput };

/** A provider returns the model's raw text. Parsing and validation happen once, in the adapter. */
export interface Provider {
  readonly model: string;
  complete(req: ProviderRequest): Promise<string>;
}

export interface AiAdapter {
  readonly model: string;
  transcribe(image: ImageInput): Promise<AiResult<Transcript>>;
  extract(transcript: Transcript, assetHint: string | null): Promise<AiResult<Extraction>>;
}

// ---------- providers ----------

export function geminiProvider(apiKey: string, model = 'gemini-flash-latest', fetchImpl: typeof fetch = fetch): Provider {
  return {
    model,
    async complete({ system, user, image }) {
      const parts: unknown[] = [{ text: user }];
      if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
      const res = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0 },
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
      const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    },
  };
}

export function openaiCompatProvider(baseUrl: string, apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Provider {
  return {
    model,
    async complete({ system, user, image }) {
      const content: unknown[] = [{ type: 'text', text: user }];
      if (image) content.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } });
      const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`openai_compat HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return body.choices?.[0]?.message?.content ?? '';
    },
  };
}

export const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures');
export type FixtureEntry = { for: CallKind; response: unknown };

/**
 * Fixture provider (§7 fix 7). The file is a JSON array of responses returned in order; each entry is tagged
 * with the call it answers, so a screenshot fixture can hold its transcript and its extraction.
 * A string response is returned as raw text (lets a fixture be invalid JSON); anything else is JSON-encoded.
 */
export function fixtureProvider(name: string, dir: string = FIXTURES_DIR): Provider {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad fixture name "${name}"`);
  const entries = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as FixtureEntry[];
  if (!Array.isArray(entries)) throw new Error(`fixture ${name} must be a JSON array`);
  const cursor: Record<CallKind, number> = { transcribe: 0, extract: 0 };
  return {
    model: `fixture:${name}`,
    async complete({ kind }) {
      const mine = entries.filter((e) => e.for === kind);
      const entry = mine[cursor[kind]++];
      if (!entry) throw new Error(`fixture ${name} has no ${kind} response #${cursor[kind]}`);
      return typeof entry.response === 'string' ? entry.response : JSON.stringify(entry.response);
    },
  };
}

// ---------- adapter ----------

/** Pull the JSON out of a reply that may be wrapped in a ```json fence. Returns undefined when unparsable. */
export function parseJsonReply(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  try {
    return JSON.parse(fenced ? fenced[1]! : text);
  } catch {
    return undefined;
  }
}

async function callValidated<S extends z.ZodType>(provider: Provider, req: ProviderRequest, schema: S): Promise<AiResult<z.infer<S>>> {
  const attempts: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = attempt === 0 ? req : { ...req, user: `${req.user}\n\nYour previous reply was not valid JSON for the required shape. Reply with JSON only.` };
    let text: string;
    try {
      text = await provider.complete(r);
    } catch (err) {
      attempts.push({ error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const parsed = schema.safeParse(parseJsonReply(text));
    if (parsed.success) return { ok: true, value: parsed.data, model: provider.model, raw: parsed.data };
    attempts.push({ text: text.slice(0, 4000) });
  }
  return { ok: false, reason: 'ai_invalid', model: provider.model, raw: { attempts } };
}

export function createAdapter(provider: Provider): AiAdapter {
  return {
    model: provider.model,
    transcribe: (image) => callValidated(provider, { kind: 'transcribe', system: TRANSCRIBE_SYSTEM, user: TRANSCRIBE_USER, image }, TranscriptSchema),
    extract: (transcript, assetHint) =>
      callValidated(provider, { kind: 'extract', system: EXTRACT_SYSTEM, user: extractUserMessage(transcript, assetHint) }, ExtractionSchema),
  };
}

/** Fixture mode is for tests and local dev only (code-review fix 6). */
export function fixtureModeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' && (env.AI_PROVIDER ?? 'fixture') === 'fixture';
}

/** Builds the adapter from env. `fixture` names the fixture file in fixture mode (default AI_FIXTURE or "paste"). */
export function adapterFromEnv(env: NodeJS.ProcessEnv = process.env, fixture?: string): AiAdapter {
  const provider = env.AI_PROVIDER ?? 'fixture';
  if (env.NODE_ENV === 'production' && provider === 'fixture') {
    throw new Error('AI_PROVIDER must be set to gemini or openai_compat in production; fixture mode is for tests');
  }
  if (provider === 'gemini') {
    if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
    return createAdapter(geminiProvider(env.GEMINI_API_KEY, env.AI_MODEL || 'gemini-flash-latest'));
  }
  if (provider === 'openai_compat') {
    if (!env.AI_BASE_URL || !env.AI_API_KEY || !env.AI_MODEL) throw new Error('AI_BASE_URL, AI_API_KEY and AI_MODEL must be set');
    return createAdapter(openaiCompatProvider(env.AI_BASE_URL, env.AI_API_KEY, env.AI_MODEL));
  }
  if (provider === 'fixture') return createAdapter(fixtureProvider(fixture ?? env.AI_FIXTURE ?? 'paste'));
  throw new Error(`unknown AI_PROVIDER "${provider}"`);
}
