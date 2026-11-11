// Regenerates tests/fixtures/*.json (canned model replies). Run: npx tsx scripts/make-fixtures.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as T from '../tests/fixtures/texts';

type Entry = { for: 'transcribe' | 'extract'; response: unknown };
const ex = (uses: [string, string][], extra: Record<string, unknown> = {}): Entry => ({
  for: 'extract',
  response: { uses: uses.map(([optionId, quote]) => ({ optionId, quote })), suggestedPriceCents: null, clarifyingQuestion: null, ...extra },
});

const fixtures: Record<string, Entry[]> = {
  'demo-dm': [
    { for: 'transcribe', response: T.DEMO_DM },
    ex([
      ['print', T.DEMO_DM_PRINT_SENTENCE],
      ['US', 'Same US stores, nothing else changes.'],
    ]),
  ],
  paste: [ex([
    ['social', "We'd like to license the Harbor Light photo for our social media in the US for six months."],
    ['US', "We'd like to license the Harbor Light photo for our social media in the US for six months."],
    ['6mo', "We'd like to license the Harbor Light photo for our social media in the US for six months."],
  ])],
  billboard: [ex([
    ['billboard', T.BILLBOARD],
    ['6mo', T.BILLBOARD],
  ])],
  negation: [ex([['web', 'Please add web use for our site.']])],
  'unknown-sender': [ex([
    ['social', 'We need the Morning Pour photo for social in the US for 6 months.'],
    ['US', 'We need the Morning Pour photo for social in the US for 6 months.'],
    ['6mo', 'We need the Morning Pour photo for social in the US for 6 months.'],
  ])],
  hallucinated: [ex([
    ['web', T.HALLUCINATED],
    ['US', T.HALLUCINATED],
    ['6mo', T.HALLUCINATED],
    ['print', 'We would also like to use it in print ads.'],
    ['radio', T.HALLUCINATED],
  ])],
  'invalid-json': [
    { for: 'extract', response: 'Sure! Here are the uses: social, web' },
    { for: 'extract', response: '```json\n{"uses": "social"}\n```' },
  ],
  'suggests-price': [ex(
    [['web', T.SUGGESTS_PRICE], ['US', T.SUGGESTS_PRICE], ['6mo', T.SUGGESTS_PRICE]],
    { suggestedPriceCents: 5000 },
  )],
  'tripwire-miss': [ex([['web', 'Please add the photo to our website too.']])],
  clarify: [ex([], { clarifyingQuestion: 'Which channels will the new campaign run on, and for how long?' })],
  'scope-unstated': [ex([['social', T.SCOPE_UNSTATED]])],
  // fix 18: the model quotes the sentence that contains "U.S." and "e.g."; it must still match.
  'us-billboard': [ex([['billboard', T.US_BILLBOARD], ['US', T.US_BILLBOARD], ['6mo', T.US_BILLBOARD]])],
  'skip-print': [ex([['web', 'Please add web use for our site.']])],
  // Each bullet is its own sentence; one quote keeps its "- " prefix to prove normalisation strips it.
  bulleted: [ex([
    ['social', 'Instagram and Facebook posts'],
    ['web', '- The homepage of our website'],
    ['US', 'United States only, for 6 months'],
    ['6mo', 'United States only, for 6 months'],
  ])],
  'uk-australia': [ex([['web', T.UK_AUSTRALIA]])],
  'billboard-and-web': [ex([['web', 'Please add our website as well.'], ['billboard', 'We also want the photo on a billboard on I-95.']])],
  // Screenshot the model cannot read: both transcribe attempts invalid -> empty draft transcript.
  'transcribe-fails': [
    { for: 'transcribe', response: 'I cannot read this image.' },
    { for: 'transcribe', response: '{"lines": "unreadable"}' },
  ],
};

const dir = join(import.meta.dirname, '..', 'tests', 'fixtures');
for (const [name, entries] of Object.entries(fixtures)) {
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(entries, null, 2)}\n`);
}
console.log(`wrote ${Object.keys(fixtures).length} fixtures`);
