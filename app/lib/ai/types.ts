// Shapes the AI adapter returns (batch-3 §2). Validated with zod; the model's JSON is never trusted.
import { z } from 'zod';

export const SPEAKERS = ['client', 'creator', 'unknown'] as const;
export type Speaker = (typeof SPEAKERS)[number];

export const TranscriptLineSchema = z.object({
  speaker: z.enum(SPEAKERS),
  text: z.string().max(4000),
});
export const TranscriptSchema = z.object({ lines: z.array(TranscriptLineSchema).max(200) });
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;

/** optionId is a free string here: unknown ids are dropped (and logged) by the checks, not rejected. */
export const ExtractionSchema = z.object({
  uses: z
    .array(z.object({ optionId: z.string().min(1).max(64), quote: z.string().max(2000) }))
    .max(50),
  suggestedPriceCents: z.number().int().nonnegative().nullish(),
  clarifyingQuestion: z.string().max(1000).nullish(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export type ImageInput = { mime: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string };

export type AiResult<T> =
  | { ok: true; value: T; model: string; raw: unknown }
  | { ok: false; reason: 'ai_invalid'; model: string; raw: unknown };
