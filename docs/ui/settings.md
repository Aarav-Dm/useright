# Settings design sheet · `/settings`

**Purpose / viewer:** creator controls rate card and autopilot permissions. `GET/PUT /api/settings` reads/replaces `rateCard`, `perDealCapCents`, `rolling30CapCents`, `dailyMaxSends`, timezone, autoChannels, askChannels, allowedClientIds and clients. PUT errors are `issues[{path,message}]`. Dollars are display text; the API uses integer cents. Exclusivity remains ask-only and unpriced.

## Wireframes

1280px desktop:
```text
+----------+---------------------------------------------------+
| NAV      | HEADER Settings                                  |
| Deals    | RATE CARD: channel | territory | duration prices  |
| Ask me   | [Social $ ] [Print $ ] ... 11 labelled inputs      |
| Ledger   |---------------------------------------------------|
| Portfolio| AUTOPILOT: per deal | per client 30d | sends/day   |
| Settings | [$500.00] [$...] [..]  Time zone [America/...]      |
|          |---------------------------------------------------|
|          | PERMISSIONS: Option | Auto | Ask me | Not offered  |
|          | Billboard             ( )    (x)       ( )         |
|          |---------------------------------------------------|
|          | CLIENTS [x] Northwind Coffee <email>               |
| Sign out | ERROR SUMMARY / RESULT          [Save settings]   |
+----------+---------------------------------------------------+
```
390px mobile:
```text
+----------------------------------+
| NAV [Menu] Settings              |
| H1 Settings                      |
| RATE CARD                        |
| Label / [price] (stacked)         |
| AUTOPILOT                        |
| Per deal [$500.00]                |
| Per-client 30-day [$...]          |
| Sends per day [..]               |
| Time zone [America/New_York]     |
| PERMISSIONS Billboard            |
| ( ) Auto (x) Ask ( ) Not offered |
| CLIENTS [x] Northwind Coffee     |
| ERROR SUMMARY / RESULT           |
| [Save settings]                  |
+----------------------------------+
```

## Component table

| Region | shadcn component + variant | Content/data | Size / spacing | Type | Colour |
|---|---|---|---|---|---|
| Heading | native h1 | Settings | mb-8 | d-page | foreground |
| Rate card | Label + Input decimal; separated fieldset | 11 rateCard entries | 3 columns / 1 mobile; gap-x-6 gap-y-4; h-11 | label / body | input / foreground |
| Limits | Label + Input | caps, dailyMaxSends, timezone | 3 columns / 1; gap-4; timezone full row | label / body | foreground / muted |
| Permissions | Table; RadioGroup (add) per option | auto/ask/off | row min 56px; 44px labels; stack per option mobile | label | foreground / accent |
| Clients | Checkbox (add) + Label | client name/email/allowed | gap-3; min 44px target | body / meta | foreground / muted-foreground |
| Errors/result | Alert destructive (add), native status | issues/notice | p-3; full border; linked fields | body | destructive / success |
| Save | Button default | busy/dirty | h-11; full mobile width | label | primary / primary-foreground |

IP-product uses grouped sections and separators, not four rounded Cards. AD-grouping puts limits and their explanations together.

## States sheet

| State | Visual change | Exact copy |
|---|---|---|
| Loading | stable skeleton field groups | “Loading your rates and limits…” |
| Empty clients | retain all other groups | “No clients yet. Requests will appear in Deals.” |
| Unchanged | Save disabled; no dirty notice | “Save settings” |
| Editing | Save enabled; old success removed | “Changes not saved yet.” |
| Invalid | inline field error + summary links | “Check the highlighted settings.” + server field message |
| Error | restore Save, preserve edits | “Couldn’t save settings. Your changes are still here. Try again.” |
| Saving | Save busy, no duplicate request | “Saving settings…” |
| Success | persistent confirmation after response | “Settings saved. Existing licences keep the prices they were sold at.” |

## Interactions

| Action | Profile / disabled | Feedback timing | Motion / reduced motion |
|---|---|---|---|
| Edit price/cap/timezone | F; editable unless saving | typing immediate; validation on blur, no premature red while partial | none |
| Change permission / client checkbox | F; never rely on colour alone | local selection immediate; persists only on Save | none |
| Save settings / Enter | P; disabled unchanged, invalid or busy | busy immediate; summary after response; finally restore | m-feedback; result m-result / static |
| Error summary link | L | focus invalid input immediately | none, no smooth scroll if reduced motion |

No silent autosave for money/permissions; no extra confirmation after the deliberate Save. FD-copy expands “Out-of-home advertising” and “Television”; AD-agency keeps consequences visible.

## Accessibility checklist

- [ ] Every input labelled and linked to field-specific issues; RadioGroup legend names option.
- [ ] Human-readable mode labels, not auto/ask/off; checkbox includes client name.
- [ ] Error summary receives focus after failed Save; successful Save does not jump focus.
- [ ] Decimal/numeric keyboard hints; visible focus; 200% zoom; no animated values.

## Demo beat

Off-camera set $500 cap and billboard ask-only. These explain the two stops at 1:40–2:05; show them only if needed for the film.

## Gaps vs current code

- Batch 7A (done, `app/app/(creator)/settings/page.tsx`): load and save have catch/finally; loading skeleton and load error with Try again; rate card grouped (channels, territory, term) with `$` inputs; limits; permissions as a RadioGroup per option (exclusive cannot be "sells on its own"); clients as Checkboxes with name and email; Save disabled until something changes, "Changes not saved yet."; dollars converted with the shared `parseCents`.
- Review fixes (B7 dashboard): a refused save shows "Check the highlighted settings." with links named by the field label that focus the field; every field error is linked with `aria-describedby` (permissions and clients too) and clears when that field is edited; unknown issue paths stay in the summary. The third permission choice reads "Not listed (still comes to you)": the server only stores "may sell on its own" (`auto_channels`), so both other choices send the request to the creator, who can still approve it by hand. Tests: `tests/b7-dashboard.test.tsx` (Settings).
- B7C phase 1 (add only): a "What happens here?" panel (fixed help text, closed by default) under the page header.
- B7C phase 2 (add only): a read-only price calculator (`components/creator/price-calculator.tsx`) on the saved rate card and limits: pick options and it shows the price from the pure `price()` in `lib/pricing`, `unsellable()` from `lib/policy-flags`, and a live example ("With these rules a $300.00 request would need your approval: ..." naming the cap or the options not set to sell on their own, or "the agent may send a $X invoice on its own, if the client is on your list and within your daily and 30-day limits"). It is labelled "Edits above count after you save" and never saves. An autopilot term tip sits by "Autopilot limits".
- Open: no on-blur client validation (the server stays authoritative). No server-side "never sell this option" rule exists; adding one is a policy change, not UI work.

## Redesign notes

Use dashboard tokens/Geist and readable field groups. Server remains authoritative for validation, rates and permissions. Do not turn changing settings into a conversation; no sliders or animated financial counters.
