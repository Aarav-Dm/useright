# Landing / 

**Purpose:** public entry for creators and clients. Explain brief → rate-card price → PayPal-confirmed file release; offer the portfolio and creator sign-in. Static server rendering, no database, model or payment call. Sources: `app/app/page.tsx`, `components/landing/landing.tsx`.

## Layout

```text
1280: [UseRight.                    Portfolio | Creator sign in]
      [For creators          | Morning Pour photo             ]
      [Your work.            |                               ]
      [Its next licence.     |                               ]
      [Product sentence     |                               ]
      [Portfolio / Sign in   | Title + portfolio caption      ]
      [From request to release | 01 Bring the brief           ]
      [Process heading         | 02 Price from your rate card ]
      [                        | 03 PayPal confirms / unlock  ]
      [Brand                          Receipt disclaimer      ]
390:  [UseRight.           Portfolio / Creator sign in]
      [For creators / heading / product sentence      ]
      [Explore Imani’s portfolio                      ]
      [Sign in to your workspace                     ]
      [Morning Pour photo / caption                  ]
      [Process heading                               ]
      [01 Brief / 02 Rate card / 03 PayPal confirms    ]
      [Brand / Receipt disclaimer                    ]
```

| Region | Component / content | Size and spacing | Type / colour |
|---|---|---|---|
| Header | Next Link navigation | 1200px max; 20px minimum gutters; 28px vertical | 32px Instrument Serif wordmark; 14px Geist links |
| Hero | Heading + product sentence | Two columns above 899px; 64px gap; 88px top | Display 64–104px; 18px body; muted text |
| Actions | shadcn Button `asChild`, Next Link | 48px minimum; 12px gap; stacked on phones | Off-white primary, dark text; restrained amber hover |
| Photo | Next Image, existing public 11.jpg | 4:5 desktop, 4:3 phone; responsive sizes | Alt: coffee poured from moka pot; no invented proof |
| Process | Semantic ordered list, three actual sequential steps | 24px number gap; 28px rows; thin dividers | 20px headings; 15px/1.7 body; mono step numbers |
| Footer | Brand + receipt wording | 24px top; wraps naturally | 12px muted |

## Shared rules and states

Use existing `theme-glass` tokens from the public portfolio: background `#060607`, secondary `#0d0d10`, text `#f3f0ea`, muted `#9b968d`, amber `#e6b873`. Instrument Serif display, Geist body and mono are already loaded by the root layout; no new fonts. `frontend-design`: preserve the approved public identity and make the hero specific to photography through the actual Morning Pour image. `impeccable`: ordered process and explicit action copy, a single reading path, no card grid or speculative statistics. `apple-design`: restrained immediate navigation, 160ms colour feedback, no decorative animation. Reduced motion removes transitions.

This page has no asynchronous content state: its normal rendered state is immediately usable without hydration. There is no empty dataset or page-level success/error request. The photo reserves its space while loading; its failure leaves the heading, description and both links usable. Navigation errors use destination routing. Do not introduce synthetic loading or success banners.

## Accessibility and interactions

Keyboard links follow header → hero actions; skip link moves to `main` (`tabIndex=-1`). One h1, labelled sections, semantic nav/main/footer and ordered steps. Decorative arrows/numbers are hidden from assistive technology. Links have visible amber focus outlines; the primary action retains dark text against off-white/amber. Links navigate immediately without a busy state. Mobile buttons are 48px minimum; text and footer wrap. No looping motion, scroll interception or click-only content.

## Demo and verification

The page introduces what UseRight does before the visitor chooses the portfolio or workspace. It claims neither a live payment nor ownership verification. Existing `/dev` pages had no production page guard; their server entry points now call `dev/access.ts` before rendering or redirecting, returning 404 in production without a valid creator cookie. Local development remains accessible.

Redesign: retain the two entry choices, shared public palette, real photo and three-step hierarchy. No redesign is required to use the page. The build is checked with static render/access tests and TypeScript; browser layout, navigation and network-failure behavior still need the shared final browser pass.

## B12 Part F: judge entry and process navigation
Under the two buttons, one muted 14px line: “Judging this entry? Start with Imani's portfolio, or sign in with the demo login.” Only “sign in with the demo login” links to `/login`; credentials never appear. The header adds **How it works** between the existing links, targeting `#process` on the existing process section, with `scroll-mt-24`. No section or motion is added. Frontend-design preserves the public palette and hero hierarchy; impeccable drives a direct route to the existing content; apple-design keeps navigation immediate, keyboard focus visible and reduced motion unchanged. Static-render tests verify the copy and matching anchor target. The optional Devpost URL belongs to the login page; see `login.md` for `NEXT_PUBLIC_DEVPOST_URL` (unset by default).
