// Synthetic client messages used by the fixture files and the tests. Must match the quotes in tests/fixtures/*.json.
import type { Transcript } from '../../lib/ai/types';

/** Demo DM (screenshot): social client asks to add print, buried mid-message. */
export const DEMO_DM: Transcript = {
  lines: [
    { speaker: 'client', text: 'Hi Imani! The Morning Pour shot has been doing great on our Instagram.' },
    { speaker: 'creator', text: 'So glad to hear it! What are you planning next?' },
    {
      speaker: 'client',
      text: "We're refreshing the spring menu next month. We'd also like to use it on our printed menus and in-store posters. Same US stores, nothing else changes. Can you send something over this week?",
    },
  ],
};
export const DEMO_DM_PRINT_SENTENCE = "We'd also like to use it on our printed menus and in-store posters.";

export const PASTE = "Hi, this is Northwind Coffee. We'd like to license the Harbor Light photo for our social media in the US for six months.";
export const PAID_SOCIAL = "We'd like to boost the Harbor Light post on Instagram as paid ads in the US for six months.";
export const BILLBOARD = 'We want to put the Morning Pour photo on a billboard on I-95 for the next six months.';
export const NEGATION = 'Love how the photo turned out. Please add web use for our site. We will NOT use this in print.';
export const UNKNOWN_SENDER = 'Northwind here! We need the Morning Pour photo for social in the US for 6 months.';
export const HALLUCINATED = 'Can we use the Harbor Light photo on our website in the US for six months?';
export const SUGGESTS_PRICE = "We'd like the Harbor Light image for our web site, US only, for 6 months.";
export const TRIPWIRE_MISS = 'Please add the photo to our website too. We may also run it worldwide next spring.';
export const CLARIFY = 'Could we use the photo for the new campaign?';
export const SCOPE_UNSTATED = 'We would love to use the Harbor Light photo on our Instagram.';

// fix 18 (review)
export const US_BILLBOARD = 'We want a U.S. billboard for the Morning Pour photo, e.g. on I-95, for six months.';
export const SKIP_PRINT = "Please add web use for our site. Let's skip print for now.";
export const BULLETED = 'Here is what we need:\n- Instagram and Facebook posts\n- The homepage of our website\n- United States only, for 6 months';
export const UK_AUSTRALIA = "We'd like to run the Morning Pour photo on our website in the UK and Australia too.";

// batch-4 review fix (review): creator removes a use the client asked for.
export const BILLBOARD_AND_WEB = 'Please add our website as well. We also want the photo on a billboard on I-95.';
