# Rights receipt design sheet · `/r/:id`

**Purpose / viewer:** client/creator or anyone given the receipt link reads payment/scope and current licence status. Record, not ownership verification or legal advice. Server page directly calls `receiptView(db,id)`, no receipt API. Body holds licensor/licensee (masked email), asset/title/file/fingerprint, scope, term/renewal date, price/currency, transaction/invoice ids, version/parent, issued date, collaborator note, revocation reason. `liveStatus` is separate from historical body. [Client research §8–9](research-client.md) supplies the premium printable document.

## Wireframes

1280px desktop, max680px document:
```text
+--------------------------------------------------------------+
| WORDMARK Imani                                    [View work] |
|                                                              |
|             DOCUMENT Rights receipt                           |
|             STATUS [Active]                                   |
|             ISSUED timestamp                                  |
|             ------------------------------------------------ |
|             PARTIES Licensor / Licensee                        |
|             ASSET Morning Pour / Print-resolution file        |
|             SCOPE Print + social / US / 6 months               |
|             TERM Start / End / Renewal date                   |
|             ------------------------------------------------ |
|             PAYMENT $420.00 USD                                |
|             PayPal transaction id     [Copy]                  |
|             Invoice / v2 extends v1                           |
|             ------------------------------------------------ |
|             FILE FINGERPRINT (SHA-256 full width)             |
|             Collaborator share None recorded                  |
|             ACTIONS [Print receipt] [Copy receipt link]        |
|             FOOTER Record of payment/scope, not legal advice   |
+--------------------------- c-paper ---------------------------+
```
390px mobile:
```text
+----------------------------------+
| WORDMARK Imani [View work]        |
| H1 Rights receipt                |
| STATUS [Active]                  |
| ISSUED date                     |
| PARTIES                         |
| Licensor / Imani                 |
| Licensee / Northwind / masked    |
| ASSET / FILE                    |
| SCOPE / TERM / RENEWAL           |
| PAYMENT $420.00 USD              |
| PayPal transaction id            |
| [wrapped id] [Copy]              |
| INVOICE / VERSION / PARENT       |
| FINGERPRINT wrapped              |
| COLLABORATOR note               |
| [Print receipt] [Copy link]      |
| DISCLAIMER footer               |
+----------------------------------+
```
The receipt never becomes a fullscreen “success celebration”; refunded/expired copies retain their historical facts with a changed live status.

## Component table

| Region | shadcn component + variant | Content/data | Size / spacing | Type | Colour |
|---|---|---|---|---|---|
| Client shell | Link + Separator | licensor name; safe portfolio path planned | max1152px; header72/56px | c-body | c-paper / c-text |
| Heading | h1 + Badge outline + issue date | kind, liveStatus, issuedAt | max680px; gap-3; mb-8 | c-title / label / meta | c-text; active c-success |
| Parties/asset | semantic dl | names/masked email/title/fileLabel | desktop label168px/value; stack mobile; gap-3 | c-body | c-text / c-muted |
| Terms | dl + Separator | scope.words/start/end/renewalDate | py-6; gap-3 | c-body | c-text / c-line |
| Payment proof | dl + Button ghost | price/USD, paypalTransactionId, invoiceNumber | amount mt-2; ids wrap; copy44px target | c-price / c-id | c-text |
| Version | native text/dl | versionNo/parentVersionNo | py-4 | c-body / meta | c-text / c-muted |
| File details | plain section, not Card | SHA-256 + collaborator/revokedReason | mt-6; wrap all hashes; ≤65ch | c-id / c-body | c-muted / c-error when revoked |
| Actions | Button outline + ghost | print/copy URL | h-11; gap-3; wrap mobile | label | c-clay / c-line |
| Footer | native footer | legal boundary | border-top; pt-4; print-visible | meta | c-muted |

Native document semantics are intentional; shadcn provides action/status vocabulary, not a box around every fact. FD-subject makes the record resemble a considered licensing document; AD Responsibility separates live status from issue facts.

## States sheet

| State | Visual change | Exact copy |
|---|---|---|
| Loading | document headings/skeleton facts; no fake active stamp | “Loading the rights receipt…” |
| Empty/not found | no parties/payment shown | “This receipt wasn’t found. Check the link or ask the photographer for a new one.” |
| Error | recovery region, no blank paper | “Couldn’t load this receipt. Try again.” |
| Success/active | worded active stamp, all original facts visible | “Status now: Active” |
| Superseded | neutral stamp, original proof retained | “Status now: Superseded by a newer licence” |
| Expired | neutral stamp, end date visible | “Status now: Expired” |
| Refunded/revoked | revoked stamp and reason; never active green | “Status now: Refunded, licence revoked” |
| Revocation receipt | heading explicitly changes, prior payment facts retained | “Revocation receipt” |
| Pending/draft | neutral state, no verified-active claim | “Status now: Not paid” / “Status now: Not issued” |
| Missing optional data | explicit absence, never made-up parent/renewal | “Not recorded” |
| Copy success/error | inline polite message near actions | “Receipt link copied.” / “Couldn’t copy. Select the link to copy it.” |
| Print | hide nav/actions, preserve live status and issue date | footer and all scope/payment facts unchanged |

Eyebrow: “Proof of licence” on grant receipts, “Licence record” on revocation and expired ones, with “Demo · ” in front on seeded receipts (B9 9.5 and security review finding 6; was “Certificate of commercial release”). Never “legally binding”. A seeded receipt's transaction id is followed by “Demo record, not a PayPal payment”. Persistent disclaimer: “Record of payment and scope, not legal advice.” Fingerprint helper: “Identifies the licensed file.” A renewal date is not proof of a future charge. Do not add “Ownership verified”.

## Interactions

Shared client O/G/L profiles specify hover/focus/press/disabled; the document itself is static.

| Action | Profile / disabled | Feedback timing | Motion / reduced motion |
|---|---|---|---|
| Print receipt | O; enabled once loaded | native print dialog immediately | none; no animated preview |
| Copy receipt link | G; loaded only | await clipboard; result persists inline briefly without stealing focus | m-feedback / 0ms |
| Copy PayPal transaction id | G; only if present | “Transaction id copied.” after success | m-feedback / 0ms |
| View work | L, safe server path only | ordinary navigation, no receipt token carried | none |
| Try again | O; disabled during retry | loading skeleton, no fake status retained on initial failure | m-result / static |
| Parent / back-to-payment, conditional | L only if server supplies safe path | ordinary local link | none |

Version numbers currently have no public parent receipt path; render plain “extends v1”, not a dead link. Never synthesize a payment bearer token from receipt fields. No download from this page based only on the presence of a receipt.

## Accessibility checklist

- [ ] One h1; dl/dt/dd semantics; logical issue/live-status distinction.
- [ ] Wrapping, selectable full ids/hash; Copy accessible names identify the field.
- [ ] Meaningful status words/icons; reading order same on mobile/print; 200% zoom.
- [ ] No motion, auto-scroll or focus change from status refresh; error alert is announced.
- [ ] Privacy metadata preserved; masked email only; no analytics with public receipt id.
- [ ] Print preserves transaction, term and current status; removes interactive controls.

## Demo beat

End of 1:05–1:40: show scope, verified payment id and renewal date in one legible frame. Receipt connects payment to allowed use; it does not certify authorship or guarantee auto-renewal. PayPal proof comes from actual captured receipt data.

## Gaps vs current code

- `app/app/r/[id]/page.tsx:16`: generic notFound; no tailored loading/error recovery page.
- `app/app/r/[id]/page.tsx:21`: plain status text; `:27` raw hash precedes scope/price and dominates the document.
- `app/app/r/[id]/page.tsx:19`: no shared client shell, print/copy/navigation controls or shadcn status/action components.
- `app/lib/receipts.ts`: renewalDate currently equals endAt pending renewal implementation.
- Batch-6 review F9/F15 (done): every body is read through `normalizeReceiptBody` (legacy seed bodies mapped, emails masked); a "PayPal payer" row shows the masked payer or "Not provided by PayPal".
- `app/lib/receipts.ts:83`: no preview URL, safe portfolio path, parent-receipt path or pay path. Optional thumbnail/navigation requires a public-safe projection, not access to creator-only asset data.

## Redesign notes

Reuse portfolio's Fraunces, paper/clay and mono identifiers, with zero spectacle. Avoid nesting Cards or treating all non-active states as green success. Keep full legal/payment facts in print; technical fingerprint follows the readable licence. Client research §9 and AD Purpose/Wayfinding drive this quiet endpoint.

## Batch 8
- The "Renewal date" row became "Renewal": "invoice from <end − 7 days>, a week before it ends" (B8 review fix 9) when the client ticked the pay page box (read live from the licence), otherwise "not requested".
- An ended licence gets an "Expired receipt" (`kind: 'expiry'`, status `expired`) and a revocation receipt (status `expired`, reason "The licence term ended; downloads stopped."); the page title names the kind.

## B12 Part E: date-zone verification
Issue, term and renewal dates already use `shortDate(value, r.timeZone)` at 0622630. Preserve that shared formatter; no further receipt component change is needed. A focused test supplies timestamps just after UTC midnight and requires both Issued and Term to show the preceding day in America/New_York. This is display only; do not rewrite payment timestamps or licensed term boundaries to force issue and term to be the same calendar day.

- B12 Part B (2026-11-11): PayPal payer, Term and Invoice rows are left out when they have no value.
- B12 D1 (2026-11-11): PayPal re-check and PayPal webhook rows above Version, from `ReceiptView.proof`; absent on seeded receipts.
