# Home design sheet · `/`

**Purpose / viewer:** route a visitor to her creator workspace. No marketing or portfolio content. Current `app/app/page.tsx:4` redirects to `/deals`; the creator layout checks the cookie. No data handler or page fields. [System tokens/profiles](README.md) apply; AD-purpose drives keeping this route silent.

## Wireframes

1280px desktop, transient fallback only:
```text
+--------------------------------------------------------------+
| MAIN: canvas background                                      |
|                                                              |
|             +-- ROUTING, max 400px ----------------+           |
|             | H1 Opening your workspace           |           |
|             | STATUS Opening your deals...        |           |
|             | RECOVERY [Open deals]               |           |
|             +-------------------------------------+           |
+--------------------------------------------------------------+
```
390px mobile, 16px inset:
```text
+----------------------------------+
| MAIN                             |
| H1 Opening your workspace        |
| STATUS Opening your deals...     |
|                                  |
| RECOVERY [Open deals]            |
+----------------------------------+
```
No visible success page: both wireframes are navigation/failure fallbacks, not an extra screen to wait through.

## Component table

| Region | shadcn component + variant | Content/data | Size / spacing | Type | Colour |
|---|---|---|---|---|---|
| Main | native main | no data | min 100dvh; p-8 / p-4 | body | background / foreground |
| Routing | native section, no Card | pending route | max-w-[400px]; gap-4 | body | background |
| Title | native h1 | Opening your workspace | mb-2 | d-page | foreground |
| Status | native p role=status | navigation status | min-h-6 | body | muted-foreground |
| Recovery | Button outline asChild | href=/deals | h-11, px-4 | label | border / foreground |

## States sheet

| State | Visual change | Exact copy |
|---|---|---|
| Loading | status appears only if routing fallback is rendered; no artificial delay | “Opening your deals…” |
| Empty | not applicable; do not render blank destination | none |
| Error | recovery link visible with descriptive status | “We couldn’t open your workspace. Open Deals to try again.” |
| Success, signed in | replace route immediately with Deals | no confirmation screen |
| Success, signed out | replace route with Sign in | “Sign in to UseRight” on destination |

## Interactions

Profiles fully define hover/focus/pressed/disabled in README.

| Action | Profile / disabled | Feedback timing | Motion / reduced motion |
|---|---|---|---|
| Automatic routing | no interactive control | redirect as soon as session check resolves | none; no logo animation |
| Open deals | O link; never disabled during failed routing | normal navigation immediately on activation | m-feedback / 0ms |

AD-wayfinding requires the recovery path; IP-product forbids turning navigation into a choreographed entrance.

## Accessibility checklist

- [ ] Fallback main has one h1 and status announcement; no repeated “loading” announcements.
- [ ] Open deals is a real keyboard link with visible focus, not a JavaScript-only button.
- [ ] No automatic focus loop or motion; text scales to 200%.

## Demo beat

None directly. Film begins on `/c/imani` at 0:00; sign in before the 0:12 screenshot beat. This route must not introduce an extra filmed click.

## Gaps vs current code

- Batch 7A: unchanged by design. `app/app/page.tsx` redirects to `/deals`; the creator layout sends a signed-out visitor to `/login`. No fallback screen is rendered because routing is immediate.
- Open: `app/app/(creator)/layout.tsx` still drops the destination on the login redirect (pages pass `?next=` themselves on a 401).

## Redesign notes

Keep this minimal; no homepage hero, chatbot or dashboard metrics. The fallback can remain unused if server routing is immediate. FD-subject puts the design effort into the evidence-to-payment screens.
