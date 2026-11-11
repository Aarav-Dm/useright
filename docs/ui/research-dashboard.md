# Creator dashboard: UI research (crafted, not vibecoded)

Research for the creator screens (`/deals`, `/deals/[briefId]`, `/ask`, `/ledger`). Input for the human's redesign (Nov 6-9) and for any builder touching these pages before then. Research notes only; the implementation is in `app/`.

Written 2026-10-29 by the UI researcher temp. Sources are cited inline; where a source is a third-party write-up rather than the vendor's own docs, it says so.

## How to read the rankings

Each idea names its page and an **impact / effort** pair.
- **Impact**: how much it helps the recorded demo and the Design criterion (High / Med / Low).
- **Effort**: S = under half a day, M = about a day, L = two days or more.
- Ideas inside each section are ordered best ratio first.

## The one framing decision

UseRight's agent is **not a chat**. The model only reads the brief; code prices it, code runs R1-R5, code sends the invoice, and PayPal decides "paid" (spec §4, "The model has no write tool"). So the UI should not imitate a chatbot at all. It should show **an agent's work as structured, checkable output**: steps, quotes, line items, rule verdicts, PayPal states. That is both more honest and more distinctive than a chat window, and it matches the product's whole pitch (the agent proposes, the engine decides).

Consequence: we do **not** need the Vercel AI SDK's chat runtime (`useChat`, `streamUI`). We borrow its *vocabulary* (typed parts with explicit states) and render it from our own route handlers. Screens stay dumb, as `AGENTS.md` requires.

---

## 1. Generative UI and AI-native patterns, translated to our screens

### What the field does

- **Typed tool parts with states (Vercel AI SDK UI).** Each assistant message is a list of `parts`; a tool part is typed `tool-${toolName}` and moves through states such as `input-available` (running), `output-available` (render the result component) and `output-error` (render the error) ([AI SDK: Generative UI](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)). `streamUI` belongs to the older AI SDK RSC track, which is experimental with development paused; Vercel recommends AI SDK UI for production ([AI SDK RSC reference](https://ai-sdk.dev/v4/docs/reference/ai-sdk-rsc), [Vercel RSC GenUI template](https://blog.vercel.com/templates/ai/rsc-genui)). **Takeaway: do not build on `streamUI`.**
- **Approval as a first-class tool state.** AI SDK 6 adds `needsApproval` on a tool (boolean, or a function of the input, e.g. only payments above a threshold) and an `approval-requested` part state; the client answers with `addToolApprovalResponse`. The docs warn that history is client-controlled input, so approvals must be re-validated server-side ([AI SDK: Tool approvals](https://ai-sdk.dev/docs/agents/tool-approvals), [AI SDK 6 beta announcement](https://ai-sdk.dev/docs/announcing-ai-sdk-6-beta)). Our `/ask` already does the stronger version (typed total, version hash, re-check on send; spec A6).
- **AI Elements (Vercel, built on shadcn/ui).** A shadcn registry of agent components: `Tool` (collapsible card with name and status badge), `Confirmation` (request / accepted / rejected), `Chain of Thought` (a step rail of labelled stages) ([AI Elements on 21st.dev](https://21st.dev/@vercel/library/ai-elements); third-party descriptions at [shadcn.io/ai/tool](https://www.shadcn.io/ai/tool), [shadcn.io/ai/confirmation](https://www.shadcn.io/ai/confirmation), [Neon UI chain-of-thought](https://ui.neon.com/agent/chain-of-thought)). Installable per component with the shadcn CLI, so they fit our "add with the CLI, never hand-roll" rule. Treat them as a starting skeleton, then restyle (section 3).
- **Linear's Agent Session.** The best public model of "agent activity that is not chat": a session has a state (pending, active, error, awaitingInput, complete, stale) derived from the last activity; activities are typed (thought, action, elicitation, response, error); an action shows a label plus parameter and flips tense when done ("Searching" to "Searched"), with its result appended; a session-level plan is a checklist of pending / in-progress / completed / canceled items ([Linear: Agent interaction](https://linear.app/developers/agent-interaction), [Linear: Agents](https://linear.app/developers/agents)).
- **Show the work (Perplexity and others).** Perplexity Pro plans steps, runs a search per step, and exposes intermediate steps; the team found inspecting those steps was critical ([LangChain case study: Perplexity](https://www.langchain.com/breakoutagents/perplexity)). Every claim gets a clickable footnote to its source ([G2 review](https://learn.g2.com/perplexity-ai-review)).
- **Transparency patterns (Smashing, 2026).** Named patterns: Living Breadcrumb (rotating status for low-stakes tasks), Dynamic Checklist (planned steps marked done / in progress / pending, for high-stakes work), Thinking Toggle, Audit Trail, Partial Success (itemise what passed and failed instead of one red banner), Disentangling the Tool (name the external service at fault). Status text should name the action, the object and the constraint, never "Loading". Results get a receipt showing how figures were computed ([Smashing: Practical interface patterns for AI transparency, part 2](https://www.smashingmagazine.com/2026/05/practical-interface-patterns-ai-transparency/)).
- **Approval UX guidance.** Gate only risky steps or approvals become rubber stamps; log approvals with time and reviewer ([AWS Agentic AI Lens](https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/agentsec04-bp02.html)). In a dashboard an approval can be a queue rather than a chat message; handle declines explicitly ([Mastra: Human-in-the-loop](https://mastra.ai/blog/human-in-the-loop-when-to-use-agent-approval)). Keep the action log separate from conversation; give approve/undo the care of a primary CTA; put "Why?" on demand ([Towards AI: Designing for AI agents](https://pub.towardsai.net/designing-for-ai-agents-8-ux-patterns-that-build-trust-in-2026-713a0c926933)). An approval screen is only as good as the evidence it surfaces ([DEV: Show the agent's evidence before asking a human to approve](https://dev.to/haaaaaley/show-the-agents-evidence-before-asking-a-human-to-approve-its-diff-25gj)).
- **Command palette.** shadcn `Command` wraps cmdk (fuzzy filter, keyboard nav, a11y); `CommandDialog` + a global ⌘K/Ctrl+K listener is the standard pattern ([shadcn Command](https://ui.shadcn.com/docs/components/command), [designrevision: Command](https://designrevision.com/components/command)). Raycast and Linear made this the expected power-user entry point; impeccable's product register lists command palettes as a permitted standard pattern (`.claude/skills/impeccable/reference/product.md`).

### Patterns we adopt (ranked)

| # | Pattern | Page | Impact / Effort | Source of the idea |
|---|---|---|---|---|
| 1.1 | **Agent run rail**: a vertical checklist of the real pipeline steps for one deal: Read brief, Transcribe, Extract uses (n quotes), Tripwire check, Price from rate card, Policy R1-R5, Send invoice, PayPal status. Each step is pending / running / done / stopped, past tense when done ("Priced 3 lines from rate card v1"). Rendered from data the brief route already returns; no new logic. | deal room | High / M | Linear plan + activity tense; Smashing Dynamic Checklist |
| 1.2 | **Rule verdict strip**: R1-R5 as five labelled chips in one row, each pass / stop with a one-line reason on hover/focus and inline when stopped ("R2 stopped: $900 is over your $500 per-deal cap"). Partial success, not one red banner. | deal room, ask, ledger | High / S | Smashing Partial Success; AWS risk-tiered gates |
| 1.3 | **Quote-to-line footnotes**: every gap line carries a small numbered marker linking to the highlighted client sentence that justified it; hovering either side highlights the other. The model's suggested price shown struck out next to the code price, labelled "Model suggested (ignored)". | deal room | High / M | Perplexity footnotes; spec §5 deal room |
| 1.4 | **Approval card with evidence**: /ask items show why they stopped (the failing rules), the line items, the recipient, then the typed-total field. The approve button only enables when the typed value parses to the exact total; after approval the card flips to "Approved, invoice sent" with the invoice id. Decline is a real action with its own state. | ask | High / S | AI Elements Confirmation; DEV evidence-first; Mastra declines |
| 1.5 | **Ambient agent status** in the nav: one line, "Autopilot on · 2 waiting for you · last send 4 min ago", linking to /ask. No pulsing orb (human dislikes them; memory). | layout | Med / S | Linear session state; Smashing Living Breadcrumb |
| 1.6 | **Specific status copy**: replace "Loading…" / spinners with what is happening: "Asking PayPal for invoice UR-3f2a… status", "Re-checking payment (PayPal decides, not us)". | all | Med / S | Smashing status messages |
| 1.7 | **Name the external system on error**: "PayPal sandbox did not answer in 10 s. Nothing was sent; retry is safe because invoice UR-… is stored." | deal room, ask | Med / S | Smashing Disentangling the Tool; spec Y6 |
| 1.8 | **⌘K palette**: jump to a deal by client or invoice number, "Paste a brief", "Open ask queue", demo-panel actions (reset, advance clock). | layout | Med / M | shadcn Command / cmdk |
| 1.9 | Use AI Elements `Tool` / `Confirmation` / `Chain of Thought` as copied-in skeletons for 1.1 and 1.4, then restyle. Optional: plain shadcn primitives are enough. | deal room, ask | Low / S | AI Elements |

Do **not**: add a chat box "ask the agent anything" to the creator screens (it would invite the question "can the model send money?", which the product's answer is no). The read-only AG Studio agent on the ledger (spec §5) is the one sanctioned conversational surface.

---

## 2. Screen-by-screen design ideas

All of these render what route handlers already return. Where a field does not exist yet, it is marked *(needs data)* so a builder raises it rather than computing it in the component.

### /deals (list)

Job: "what needs me, what is in flight, what got paid". It is a work queue, not a gallery.

| Idea | Impact / Effort |
|---|---|
| **A table, not cards.** Columns: client, asset, what changed (e.g. "+ print, + 12 mo"), amount (right-aligned, tabular), status, updated. Card grids are the top vibecoded tell (section 4). | High / S |
| **Status as words with a shape, not dots alone**: "Waiting for you", "Invoice sent", "Paid · file unlocked", "Stopped by R2". Group or sort so "Waiting for you" is on top. | High / S |
| **Inline "why stopped"** under a stopped row in muted text: the rule and its reason. | Med / S |
| **Empty state that teaches**: "No deals yet. Paste a client's message or screenshot and the agent will read it." with the paste action. | Med / S |
| Keyboard: j/k to move, Enter to open; no row animation (frequency rule below). | Low / S |

### /deals/[briefId] (deal room)

Job: prove, at a glance, that every dollar comes from the rate card and every use comes from the client's own words. This is the demo's 0:12-0:55 beat; it deserves most of the effort.

Layout (spec §5: client's words left, licence right):

```
┌ Northwind · Hero shot 014 ─────────────── Invoice sent · UR-3f2a… ┐
│ [run rail: Read ✓  Extract ✓  Tripwire ✓  Price ✓  R1-R5 ✓  Sent ✓  PayPal: awaiting] │
├──────────────────────────────┬──────────────────────────────────┤
│ CLIENT'S WORDS               │ LICENCE                          │
│ Northwind: "...for the       │ Has (v1)      Wants (v2)         │
│ spring social push..."       │ social        social             │
│ Northwind: "[1]we'll also    │ US            US                 │
│ run it in the print          │ 6 mo          12 mo              │
│ catalogue[/1]."  ← highlight │               + print  [1]       │
│                              ├──────────────────────────────────┤
│                              │ GAP (rate card v1, frozen)       │
│                              │ Print, US          $300.00  [1]  │
│                              │ +6 months          $120.00  [2]  │
│                              │ ───────────────────────────      │
│                              │ Total             $420.00        │
│                              │ Model suggested  ~~$350~~ ignored│
│                              │ R1 ✓ R2 ✓ R3 ✓ R4 ✓ R5 ✓          │
└──────────────────────────────┴──────────────────────────────────┘
```

| Idea | Impact / Effort |
|---|---|
| **Run rail across the top** (1.1). The single thing judges will remember: an agent's work shown as auditable steps. | High / M |
| **Highlighter quotes** (signature element, section 3): client sentences used as evidence get a real highlighter mark (the existing `--highlight` token), with the footnote number. Tripwire words that stopped the run get an underline in the warning colour, not a second highlight colour. | High / S |
| **Has vs Wants diff** of the licence: two aligned columns; added scope shown with a "+" and the added-scope colour, unchanged scope muted. Diffs are the established pattern for reviewing AI changes ([LogRocket: Agentic AI frontend patterns](https://blog.logrocket.com/agentic-ai-frontend-patterns/)). | High / M |
| **Price breakdown as a receipt**: line items in Geist Mono with tabular figures, right-aligned, a rule above the total, "rate card v1 (frozen)" in the header, footnote markers back to quotes (1.3). The struck-out model price sits under the total. | High / S |
| **R1-R5 strip** under the total (1.2). | High / S |
| **Invoice status as a stepper** in the header: Draft, Sent, Paid (PayPal confirmed), File unlocked. "Paid" only lights after `grantIfPaid`; a "Marked as paid manually: file stays locked" state is a distinct, explained state (spec acceptance test). | High / S |
| Transcript speaker labels as small caps text, not avatars or emoji. | Low / S |

### /ask (approvals)

Job: one decision per item, made on evidence, with friction proportional to risk (typed total).

| Idea | Impact / Effort |
|---|---|
| **Evidence-first approval card** (1.4): reason it stopped (failing rules in plain words), line items, recipient, then "Type the total to approve" with the expected format shown as the placeholder ("900.00"). Button label states the effect: "Approve and send $900.00 invoice". | High / S |
| **Typed-total feedback**: as the creator types, show a neutral check when it matches, nothing while partial, and a specific message on mismatch at blur ("That is $90.00; this quote totals $900.00"). No shake animation. | Med / S |
| **Queue, not modal**: items stack on the page; the finished card stays with its outcome until dismissed (current behaviour, keep it). Modals are banned as a first thought by impeccable. | Med / S |
| **Decline with reason** (optional free text) recorded to the ledger. | Low / S |

### /ledger

Job: the audit trail and the AG Grid sponsor proof (spec §5, D10). The spec says AG Studio keeps AG's look, themed to our colours.

| Idea | Impact / Effort |
|---|---|
| **Theme AG Grid from our tokens**: `themeQuartz.withParams({ ... })` with background, foreground, header colours, `fontFamily` / `cellFontFamily` from our CSS variables, so the grid matches the app instead of looking pasted in ([AG Grid Theming API](https://www.ag-grid.com/react-data-grid/theming-api/), [colours](https://www.ag-grid.com/react-data-grid/theming-colors/), [fonts](https://www.ag-grid.com/react-data-grid/theming-fonts/), [parameters](https://www.ag-grid.com/javascript-data-grid/theming-parameters/)). | High / S |
| **Rule column renders the verdict chips** (1.2) via a cell renderer; PayPal ids in mono, truncated with copy-on-click. | Med / S |
| **Row expand = audit trail** for one event: what the agent proposed, what code decided, what PayPal returned (Smashing Audit Trail). | Med / M |
| Money right-aligned, tabular; dates relative with absolute on hover. | Med / S |

---

## 3. shadcn/ui best practice: tokens, components, de-defaulting

Current state: `app/app/globals.css` holds the stock neutral theme (its own comment says so) and no font is set (`app/app/layout.tsx`), so the app renders in the browser default face. Installed: badge, button, card, input, label, select, table, textarea; `lucide-react` for icons.

### How theming works (Tailwind v4)

- Tokens are CSS variables in `:root` and `.dark`, values in OKLCH, each surface paired with a `-foreground`; `@theme inline` maps them to `--color-*` so `bg-primary` etc. exist. Custom tokens (e.g. `--warning`) are defined in both blocks and mapped the same way. `--radius` is the base and the scale derives from it. Base colours offered: Neutral, Stone, Zinc, Mauve, Olive, Mist, Taupe ([shadcn: Theming](https://ui.shadcn.com/docs/theming)).
- Keep all tokens in `globals.css` only (steering `ui.md`: "tokens in one place") so the Nov 6-9 reskin is a token edit.
- Theme editors such as tweakcn can tune a palette by eye before locking it ([Robots on Payroll: avoid the vibe-coded look](https://robotsonpayroll.substack.com/p/how-to-avoid-that-vibe-coded-look), [shadcnblocks: Theming](https://www.shadcnblocks.com/docs/blocks/theming)).

### Proposed token plan (draft for the human; product register, Restrained strategy)

Scene sentence (impeccable "Theme" rule): *Imani, a working photographer, checks deals on a laptop between shoots in a daylight studio, wanting to be sure no use slips through unpaid.* That forces **light**, calm, paper-like, high legibility.

| Role | Token | Proposal | Why |
|---|---|---|---|
| Surface | `--background` | very light neutral tinted toward a cool green-grey (chroma ~0.005), never `#fff` | impeccable: tint neutrals |
| Panel layer | `--sidebar`, `--muted` | one step darker, same hue | second neutral layer for nav and the licence column |
| Ink | `--foreground` | near-black of the same hue, never `#000` | |
| Accent | `--primary` | one deep ink green used only for primary actions, current selection and "paid / unlocked" | Restrained: accent ≤10%; green = money cleared, but deep, not neon |
| Evidence | `--highlight` (exists) | highlighter yellow, used **only** on quoted client words | the signature element |
| Added scope | `--added` (new) | a muted blue for "+ print" in the Has/Wants diff | distinct from both accent and warning |
| Stop | `--warning`, `--destructive` | amber for "stopped, needs you"; red only for real failures | a stop by policy is not an error |
| Radius | `--radius` | smaller than default (~0.375rem) | tighter, document-like; less "template soft" |

Typography: **Geist Sans** for UI and **Geist Mono** for money, ids and the receipt, both OFL, loaded via the `geist` npm package (which keeps `font-feature-settings` support; the Google Fonts build does not) ([Vercel: Geist](https://vercel.com/font), [geist README](https://cdn.jsdelivr.net/npm/geist@1.7.1/README.md)). One family plus a mono is right for product UI (impeccable product register). Use `tabular-nums` (Tailwind) on every money column; right-align amounts, as Stripe-style dashboards do ([adminlte: dashboard examples](https://adminlte.io/blog/25-best-dashboard-design-examples-for-2026-real-products-principles/); third-party Stripe teardown at [design.hagicode.com](https://design.hagicode.com/designs/stripe/)). Type scale ratio 1.125-1.2, fixed rem.

Signature (frontend-design "one memorable thing"): **the highlighter**. The client's own sentence, marked like a contract someone went over with a pen, tied by a footnote number to the dollar line it caused. Everything else stays quiet.

### Which components fit

| Need | shadcn component | Note |
|---|---|---|
| Deals list, gap lines | `Table` (installed) | not Card |
| Rule chips, status | `Badge` (installed) | text + icon, not colour alone |
| Run rail | plain list + lucide icons, or AI Elements Chain of Thought | |
| R reason on hover/focus | `Tooltip` (add) | must also work on focus |
| Ask approvals | `Input`, `Label`, `Button` (installed), `Alert` (add) | |
| Toasts ("Invoice sent") | `Sonner` (add) | short, state only |
| ⌘K | `Command` (add) | |
| Skeleton loading | `Skeleton` (add) | impeccable: skeletons, not centred spinners |
| Sections in the deal room | `Separator` (add) | instead of nested cards |

Blocks: shadcn's sidebar and dashboard blocks are fine as structure references, but copying a dashboard block wholesale (stat cards row + chart + table) produces exactly the hero-metric template impeccable bans. Take the sidebar shell; skip the stat-card row.

### De-defaulting checklist for shadcn

1. Change the tokens (above), radius and font before anything else; most "default shadcn" look is neutral-grey + 0.625rem radius + system font.
2. Remove the `Card` wrapper wherever a section heading and spacing would do; never nest cards.
3. Vary spacing deliberately: dense tables, generous space around the total and the approval field.
4. One icon set (lucide), one stroke width, sized to the text; no emoji.
5. Shadows: none or one subtle level for popovers only.
6. Focus rings visible and tokenised (`--ring`), never removed.

---

## 4. Anti-vibecoded checklist

The tells, with what we do instead. Sources: [Fountain Institute: 7 tells a UI is AI-generated](https://pages.thefountaininstitute.com/posts/7-tells-that-a-ui-is-ai-generated), [Robots on Payroll](https://robotsonpayroll.substack.com/p/how-to-avoid-that-vibe-coded-look), [CodeMySpec: vibe-coded sites look the same](https://codemyspec.com/blog/vibe-coded-websites-look-the-same), [prg.sh: why your AI keeps building the same purple gradient site](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website), and the project skills (`frontend-design`, `impeccable`). These are opinion pieces and design-practice heuristics, not measured studies.

| Tell | Instead (for us) | Pages |
|---|---|---|
| Purple-to-blue / indigo gradients (traced to Tailwind UI's old `bg-indigo-500` default) | flat tokens; one deep green accent; no gradients | all |
| Gradient text | solid colour; emphasis by weight or size (impeccable ban) | all |
| Inter or system default everywhere, untuned | Geist + Geist Mono with tabular money; a deliberate scale | all |
| Emoji as icons or bullets | lucide icons or plain words | all |
| Cards on cards; identical card grids | tables, sections divided by space and `Separator` | deals, deal room |
| Coloured side-stripe borders on cards/alerts | full-border alert or tinted background (impeccable ban) | ask, deal room |
| Status dots that mean nothing | status words with an icon; colour is never the only signal | deals, ledger |
| Neon multi-accent palette; glowing dark mode | Restrained light theme; one accent ≤10% | all |
| Glassmorphism as decoration | solid panels | layout |
| Hero-metric row (big number, small label, gradient) | the work queue first; numbers live where they are used | deals |
| Centred hero, pill badge above headline | product UI starts in the task; left-aligned page titles | all |
| Generic copy ("Supercharge your workflow", "Loading…") | specific copy naming the object and the PayPal state | all |
| Em dashes in UI copy | commas, colons, periods (impeccable) | all |
| Decorative motion, page-load choreography, pulsing orbs | motion only for state change, 150-250 ms, ease-out; none on keyboard actions | all |
| Modal for everything | inline queue and inline confirm | ask |

### Motion rules (feasibility: fast on a laptop, reduced motion respected)

- Motion only conveys state: a step in the run rail turning done, the invoice stepper advancing, a toast. 150-250 ms, exponential ease-out, transform and opacity only (impeccable; `apple-design` skill).
- Frequency rule: actions done many times a day (keyboard nav, row focus, typing) get no animation; rare moments (file unlocked after PayPal confirms) may get one small, deliberate transition ([emilkowalski/skills, frequency rule (mirror)](https://instagit.com/emilkowalski/skills/when-to-avoid-animating-keyboard-initiated-actions/)).
- `prefers-reduced-motion: reduce`: replace slides with short cross-fades or nothing (`apple-design` skill, lines ~211-221). In Tailwind use `motion-safe:` / `motion-reduce:` variants (e.g. `animate-spin motion-reduce:animate-none`) ([Epic Web: motion-safe and motion-reduce](https://epicweb.dev/tips/motion-safe-and-motion-reduce-modifiers), [Tailwind: transitions](https://tailwindcss.com/docs/transition-property)).
- No animation libraries are required; CSS transitions plus `tw-animate-css` (already installed) cover everything above. No paid libraries anywhere in this doc.

### The final check (before recording)

Screenshot each of the four screens, paste into a fresh chat, ask "which AI app builder made this?". If it names one, fix the tell it points at ([Robots on Payroll](https://robotsonpayroll.substack.com/p/how-to-avoid-that-vibe-coded-look)). Then impeccable's product slop test: would a Linear or Stripe user trust this screen without pausing?

---

## Top 8 by demo impact vs effort

1. Deal room price breakdown as a mono receipt with footnotes to quotes, model price struck out. High / S
2. R1-R5 verdict strip with plain reasons (deal room, ask, ledger). High / S
3. Tokens + Geist fonts + radius in `globals.css` (kills the default-shadcn look everywhere). High / S
4. Highlighter quotes as the signature element. High / S
5. Evidence-first approval card on /ask with "Approve and send $900.00 invoice". High / S
6. Invoice stepper with a distinct "marked paid manually: still locked" state. High / S
7. AG Grid themed from our tokens. High / S
8. Agent run rail on the deal room. High / M
