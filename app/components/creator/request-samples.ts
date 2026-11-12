// Batch 7C: sample client messages for the demo, loaded into the "Add client request" sheet. Each text matches a
// fixture in tests/fixtures (the fixture name is honoured only in fixture mode outside production; with a real AI the
// text is read normally). `tests/b7c-request-sheet.test.tsx` keeps these texts equal to tests/fixtures/texts.ts.

export type Sample = {
  key: string;
  label: string;
  /** What the creator should expect, in plain words. */
  expect: string;
  source: 'paste' | 'screenshot';
  text?: string;
  image?: string;
  fixture: string;
  clientEmail: string;
  assetTitle: string;
};

/** review B7C-1 finding 2: samples describe the message, never predict the decision; the creator can change the rules. */
const MAY_SEND = ' If every rule passes, UseRight may send a PayPal invoice to buying@northwind.example with no other click.';

export const SAMPLES: Sample[] = [
  {
    key: 'print', label: 'Print add-on', source: 'paste', fixture: 'demo-dm',
    expect: 'Northwind already holds social for Morning Pour and now asks for print. What happens depends on your current settings.' + MAY_SEND,
    text: [
      'client: Hi Imani! The Morning Pour shot has been doing great on our Instagram.',
      'creator: So glad to hear it! What are you planning next?',
      "client: We're refreshing the spring menu next month. We'd also like to use it on our printed menus and in-store posters. Same US stores, same six months as our current licence, nothing else changes. Can you send something over this week?",
    ].join('\n'),
    clientEmail: 'buying@northwind.example', assetTitle: 'Morning Pour',
  },
  {
    key: 'billboard', label: 'Billboard ask', source: 'paste', fixture: 'billboard',
    expect: 'A billboard on top of the social licence. Whether it is sent or waits in Ask me depends on your current settings.' + MAY_SEND,
    text: 'We want to put the Morning Pour photo on a billboard on I-95 for the next six months.',
    clientEmail: 'buying@northwind.example', assetTitle: 'Morning Pour',
  },
  {
    key: 'social', label: 'New photo, social', source: 'paste', fixture: 'paste',
    expect: 'A first licence for Harbor Light. What happens depends on your current settings.' + MAY_SEND,
    text: "Hi, this is Northwind Coffee. We'd like to license the Harbor Light photo for our social media in the US for six months.",
    clientEmail: 'buying@northwind.example', assetTitle: 'Harbor Light',
  },
  {
    key: 'paid', label: 'Paid ads ask', source: 'paste', fixture: 'paid-social',
    expect: 'Social use, but the client wants to run it as paid ads, and your rate card has no line for that. The agent stops with no price; you can reject it or add a new request without paid use.',
    text: "We'd like to boost the Harbor Light post on Instagram as paid ads in the US for six months.",
    clientEmail: 'buying@northwind.example', assetTitle: 'Harbor Light',
  },
  {
    key: 'screenshot', label: 'DM screenshot', source: 'screenshot', fixture: 'demo-dm', image: '/samples/demo-dm.png',
    expect: 'A screenshot of the same print request. Nothing is priced until you confirm the transcript.',
    clientEmail: 'buying@northwind.example', assetTitle: 'Morning Pour',
  },
];
