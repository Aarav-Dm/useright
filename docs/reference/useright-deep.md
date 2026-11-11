# UseRight product research

_Checked 2026-10-28. Research only. Existing reports read first: [market need](market-need.md), [architecture](architecture.md), [teardown check](teardown-check.md), and [Devpost brief](devpost-brief.md). CONFIRMED means I opened the linked source; UNVERIFIED marks a point not established by the sources reviewed. Product choices below are recommendations inferred from confirmed sources, not industry rules._

## 1. License language and demo options

**CONFIRMED — PLUS is a standards vocabulary and metadata format, not a universal contract or price list.** The PLUS Coalition publishes a shared media matrix, glossary, and License Data Format (LDF). PLUS describes LDF as a metadata schema for communicating rights; each licensor chooses which fields to use. Useful fields include licensee/end user, media summary code, license start/end dates, media and region constraints, terms and conditions, and other restrictions. PLUS says it does not recommend pricing; each licensor sets their own prices. [PLUS standards](https://www.useplus.com/aboutplus/system.asp), [LDF field reference](https://www.useplus.com/useplus/license.asp), [LDF specification](https://ns.useplus.org/LDF/ldf-XMPSpecification), [PLUS packs and pricing note](https://www.useplus.com/useplus/pluspacks_more.asp)

**CONFIRMED — PLUS describes scope across media, size/quantity, duration, location, client, placement, industry, restrictions, exclusivity, and other terms.** Its suggested duration choices include 6 months, 1, 3, 5, and 10 years; suggested regions include local, regional, national, multinational, and worldwide. These are examples, not mandatory choices. [PLUS glossary](https://www.useplus.com/useplus/glossary_term.asp?pggl=1&tmid=13280000), [PLUS packs](https://www.useplus.com/useplus/pluspacks_more.asp)

**CONFIRMED — ASMP guidance says a license should specify who uses the image, how/where it appears, and how long; it also discusses media, geography, exclusivity, and sublicense/assignment limits.** [ASMP/AIA best practices](https://www.asmp.org/wp-content/uploads/2016/04/AIA_ASMP_BestPractices.pdf), [ASMP licensing guide](https://www.asmp.org/wp-content/uploads/ASMP_Legal-Jump-start_2020-03.pdf)

**CONFIRMED — Getty’s current license shows the practical usage categories requested here.** Its rights-managed/rights-ready scope can depend on specific use, medium/channel, duration, territory, print run, placement, and size; those licenses are non-exclusive unless the order terms say otherwise. Its royalty-free license is generally worldwide, perpetual, all-media, unlimited, and non-exclusive; an exclusive buyout is separately negotiated. Getty is a market example, not a template that applies to every creator. [Getty Images license agreement](https://www.gettyimages.co.uk/eula)

**Recommendation for the smallest credible demo (inference from PLUS, ASMP, Getty):**

| Field | Demo choices | Comparison rule |
|---|---|---|
| Channel/media | Website; organic social; paid digital ads; print | Keep each channel distinct; paid promotion is not silently included in organic social. |
| Territory | One country; worldwide | Treat unspecified or ambiguous territory as “needs creator review.” |
| Duration | 30 days; 1 year; perpetual | Compare campaign dates to the licensed start/end dates; missing dates are unknown, not a pass. |
| Exclusivity | Non-exclusive; category-exclusive; full exclusive | Only offer exclusive choices when the creator explicitly configured them. |
| Print run | Digital/no print; up to 1,000; 1,001–10,000; over 10,000 | Ask only for print use; escalate “unlimited” or missing quantities. |

Store the actual creator-selected limit and price per choice, not just these labels. Preserve client/end-user and named campaign/product in the license record if known; include a free-text restriction and source text for the creator to review. **UNVERIFIED:** These exact ranges are not a PLUS or ASMP standard; they are a compact demo menu. PLUS itself recommends different sample duration/region lists and leaves options to licensors.

## 2. How usage pricing works today

**CONFIRMED — Usage price is negotiated/set by the rights holder; published guidance does not supply one universal formula or standard multiplier table.** PLUS explicitly leaves prices to each licensor. ASMP says the usage fee reflects the value of authorized use and considers how widely and for how long work is viewed, reproduced, and distributed; broader use typically costs more. Getty says pricing can depend on use, size, placement, duration, and geographic distribution. [PLUS packs](https://www.useplus.com/useplus/pluspacks_more.asp), [ASMP/AIA best practices](https://www.asmp.org/wp-content/uploads/2016/04/AIA_ASMP_BestPractices.pdf), [Getty Images license agreement](https://www.gettyimages.co.uk/eula)

**CONFIRMED — Exclusive use can command more because the creator gives up the ability to license the same work to others under the same scope.** ASMP explains that a creator cannot grant a conflicting exclusive license while earlier non-exclusive licenses remain in force. [ASMP licensing guide](https://www.asmp.org/wp-content/uploads/ASMP_Legal-Jump-start_2020-03.pdf)

**UNVERIFIED — No defensible industry-wide numeric multiplier (for example, “worldwide = 2×” or “exclusive = 3×”) was established by the standards and primary sources reviewed.** Do not present any multiplier as standard.

**Recommendation (inference):** Keep the demo price deterministic and creator-authored: either a creator-entered fixed quote for each scope bundle, or `creator base × creator’s own configured factors`. Show each factor and total before approval. Never let the model invent the amount. A creator-set price table is more consistent with PLUS than a supposedly universal rate card.

## 3. Email intake and privacy

**CONFIRMED — Gmail `gmail.readonly` is a restricted OAuth scope.** It lets the app view messages and settings. Google says restricted scopes require restricted-scope verification; if the app stores or transmits restricted-scope data on its servers, a security assessment is also required. This is a substantial launch dependency for reading customer inboxes. [Google Gmail API scope list](https://developers.google.com/workspace/gmail/api/auth/scopes)

**CONFIRMED — Google OAuth testing mode is capped at 100 listed test users and test-user authorization expires after seven days.** Test users see an unverified-app warning. A production app requesting restricted scopes may need verification; Google also applies a 100-new-user cap to apps that show the unverified warning. [Google app audience/testing limits](https://support.google.com/cloud/answer/15549945?hl=en), [when verification is not needed](https://support.google.com/cloud/answer/13464323?hl=en)

**CONFIRMED — Cloudflare Email Routing can forward domain mail to a verified mailbox or route incoming mail to Workers; it requires Cloudflare DNS.** This avoids Gmail OAuth, but ordinary forwarding still lands in an existing mailbox, while Worker processing requires building that path. [Cloudflare Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/)

**CONFIRMED — Postmark accepts inbound email and sends parsed JSON to a configured public webhook. Mailgun Routes can forward or store inbound messages.** Either is a more direct app-ingestion pattern than reading a user’s entire Gmail mailbox, but both require domain/provider setup and a reachable endpoint. [Postmark inbound processing](https://postmarkapp.com/developer/user-guide/inbound), [Mailgun Routes](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/routes)

**Recommendation (inference):** For the hackathon demo, use paste/upload as the reliable brief intake. If an email address is needed for a later demo, use a dedicated Postmark inbound alias/webhook; do not connect a personal Gmail inbox. **UNVERIFIED:** Provider pricing, account approval, domain availability, and exact delivery limits were not checked.

**CONFIRMED — Gemini’s unpaid API quota/AI Studio can use submitted prompts and responses to improve products; human reviewers may read and annotate them. Google says not to submit sensitive, confidential, or personal information to unpaid services. With an active Cloud Billing account or Workspace enterprise access, the service is treated as paid for data-use terms even if AI Studio itself is free; paid prompts/responses are not used to improve Google products.** [Gemini API additional terms](https://ai.google.dev/gemini-api/terms?hl=en)

**Recommendation (inference):** Seed only synthetic client briefs and licenses in the demo. For real customer email, use a service whose terms protect that data, redact/minimize content, and set short retention; do not send real personal or confidential content to Gemini’s unpaid tier.

## 4. Is an MCP server worth it?

**CONFIRMED — The Devpost rules require PayPal plus an AI tool, but do not require or name MCP. They score technical implementation, design, impact, innovation, and presentation; “Best Use of Agentic Commerce” is a prize, not an MCP-specific prize.** [Official rules](https://paypalaihackathon.devpost.com/rules)

**CONFIRMED — The existing Devpost brief records a sandbox MCP `create_invoice` error and cautions against making MCP the only demo path.** See [Devpost brief §12](devpost-brief.md).

**Recommendation (inference):** Do not build a standalone MCP server for UseRight’s hackathon demo. It adds another integration surface without a listed score for MCP itself. Use the ordinary PayPal API for capture and delivery gating. Agentic Commerce could still be demonstrated through an AI-assisted, human-approved action, but only if the transaction path works reliably. Keep any future MCP adapter optional and outside the critical demo path.

## 5. Legal limits and product language

**CONFIRMED — This tool cannot verify copyright ownership or the creator’s authority to license an image.** U.S. Copyright Office material says the photographer is generally the initial copyright owner, but work-made-for-hire, employment, written transfers, joint ownership, and other agreements can change who owns or controls rights. Possessing a file is not the same as owning its copyright. [Copyright Office: photographers](https://copyright.gov/engage/photographers/), [Photography & Copyright](https://www.copyright.gov/engage/docs/photography.pdf)

**CONFIRMED — A license is a contract with defined scope, and ASMP advises that complex licensing terms should be reviewed by an attorney.** [ASMP licensing guide](https://www.asmp.org/wp-content/uploads/ASMP_Legal-Jump-start_2020-03.pdf)

**Recommendation (inference):** Say “possible scope mismatch—creator review required,” not “infringement” or “illegal use.” Make the creator affirm they have authority to license the work, preserve the actual terms and client approval, and describe the generated license as a draft record requiring the parties’ acceptance. Do not market UseRight as legal advice or a rights/ownership verification service. Get counsel to review production terms, consumer disclosures, and dispute/refund handling.

## 6. Top five product risks and one-line fixes

1. **CONFIRMED risk:** AI can extract a wrong channel, territory, or end date from ambiguous copy; that could falsely flag or miss an overage. **Fix:** show the exact source sentence, let the creator correct it, and block automatic approval when any field is missing or ambiguous.
2. **CONFIRMED risk:** The creator may not own or control all relevant rights, and the app cannot establish that fact. **Fix:** require an authority-to-license attestation and label ownership/release checks as unverified.
3. **CONFIRMED risk:** A small scope menu can omit important terms such as named client, product, placement, quantity, sublicensing, or image alteration. **Fix:** retain restrictions and source terms, use an explicit “other/needs review” path, and never treat unknown as permitted.
4. **CONFIRMED risk:** Gmail OAuth verification/testing limits and unpaid Gemini data handling make real inbox text a poor hackathon default. **Fix:** demo with paste/upload and synthetic text; add dedicated inbound email only after a privacy/verification plan.
5. **CONFIRMED risk:** A paid capture and file entitlement can become mismatched or duplicate on retries, especially for a paid relicense. **Fix:** bind each capture to a saved, creator-approved scope/price version and unlock only after PayPal confirms that exact capture.

## Sources checked

All linked pages above were opened. The PLUS, ASMP, Getty, Google, Cloudflare, Postmark, Mailgun, U.S. Copyright Office, and official Devpost rules pages are the primary sources used. No customer emails, real licenses, or live transactions were examined.
