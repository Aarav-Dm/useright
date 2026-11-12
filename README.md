# UseRight Agent

UseRight reads a client's request to reuse a creator's photo, prices the additional licence from the creator's rate card, and sends a PayPal sandbox invoice within the creator's limits. The file unlocks only after the server checks the payment with PayPal.

## PayPal and AI

- Gemini extracts requested uses from pasted briefs and screenshots, with supporting quotes. `AI_PROVIDER=fixture` uses canned answers locally. The model never decides prices or payment status.
- PayPal Invoicing v2 creates and sends invoices through the server-side Agent Toolkit, with a REST fallback. Webhook signatures are verified, then the invoice is fetched from PayPal before granting a licence.
- Prices use integer cents and a frozen rate card. Creator approval requires the exact total. Refunds, reversals and expiry revoke access. Seeded records are labelled Demo and excluded from verified payment totals.
- Public portfolio requests confirmed on the page require creator review; that confirmation does not verify email ownership.

This is a hackathon demonstration using PayPal sandbox money. Testing credentials belong only in private submission notes. Receipts record payment and scope; they are not legal advice. Stock photos are public demo assets; see [third-party notices](THIRD-PARTY.md).

## Run locally

Use Node.js 22.12 or newer. From the repository root:

```sh
cd app
npm ci
```

Set the environment variables below in your shell or a private environment file. Supply your own random secrets and sandbox credentials; no login is shipped here. With no `DATABASE_URL`, development uses PGlite in `app/.pglite`; uploads default to `app/.uploads`.

```sh
npm run db:init
npm run dev
```

Open `/` for the product, `/c/imani` for the seeded public portfolio, and `/login` for the creator workspace. Enter your own `CREATOR_TOKEN`. `db:init` applies migrations, seeds demo records and initializes demo files. Production needs a real model provider; fixtures are local only.

## Environment variables

Names only; keep all values private. `app/lib/` contains validation and defaults.

| Name | Purpose |
| --- | --- |
| `APP_SECRET` | Random server secret for tokens and sessions |
| `CREATOR_TOKEN` | Private creator sign-in token |
| `MY_CLIENT_ID`, `MY_PAYPAL_SECRET` | PayPal sandbox application credentials; aliases `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` take precedence |
| `PAYPAL_WEBHOOK_ID` | Registered PayPal webhook id |
| `PAYPAL_BASE`, `PAYPAL_ENV` | Sandbox endpoint by default; live use requires an explicit configuration |
| `DATABASE_URL` | PostgreSQL connection string; required on Render |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Required together for private durable file storage on Render; server only |
| `SUPABASE_BUCKET` | Optional private bucket name; default `useright-private` |
| `UPLOADS_DIR` | Local upload folder (default `.uploads`) |
| `PUBLIC_BASE_URL`, `APP_ORIGIN` | Public absolute app origin; use HTTPS when hosted |
| `CRON_SECRET` | Private daily-tick authorization secret |
| `DEMO_MODE` | `1` enables the demo clock and seeded demo controls |
| `AI_PROVIDER`, `GEMINI_API_KEY`, `AI_MODEL` | `gemini` for hosted extraction (default model `gemini-flash-latest`); local default is `fixture` |
| `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | Optional alternative model provider; select `AI_PROVIDER=openai_compat` |
| `NEXT_PUBLIC_DEVPOST_URL` | Optional public submission link; leave empty until available |

## Deploy on Render

1. Connect the public repository using the root `render.yaml` Blueprint. Set its branch to the branch you publish.
2. The service uses `rootDir: app`, build `npm ci --include=dev && npm run build`, and start `npm run start`. Health check: `/healthz`.
3. Enter every `sync: false` secret in Render. Use PostgreSQL and a private Supabase Storage bucket; local disk is not durable on the free service. Never expose the service-role key to the browser.
4. Run `npm run db:migrate` against that database, including migration 012 (row level security on every application table, without public policies). For the demo, run `npm run db:init` once against the intended demo database and storage. Keep credentials in the environment of those commands.
5. Set both public origins to the deployed HTTPS address. Register the PayPal webhook at `/api/paypal/webhook`; set the returned id privately.
6. Check that an anonymous request to `/storage/v1/object/public/useright-private/<key>` for a real stored object cannot download bytes. Check sign-in, a real sandbox payment, file unlock and receipt before sharing the site. `/dev/*` is closed in production.

Read-only buyer-agent routes are `GET /api/agent/quote` and `GET /api/agent/receipt`. They do not send invoices or deliver files. Receipt queries require the receipt id and matching SHA-256. Deploy behind a trusted ingress which appends the actual client address to `X-Forwarded-For` (or overwrites it); block direct app access so rate limits cannot be spoofed. Missing forwarding shares an `unknown` budget.

The optional daily-tick GitHub workflow needs repository secrets `TICK_URL` (full `/api/cron/tick` URL) and `CRON_SECRET`. GitHub runs a schedule only from the default branch. Use Run workflow with the hosted URL configured and require a green result before relying on it. The schedule stops after December 15, 2026.

## Checks

```sh
cd app
npx tsc --noEmit
npx vitest run --no-file-parallelism
npm run build
```

Live PayPal tests are opt-in with `LIVE_PAYPAL=1` and your own credentials. Offline tests do not prove a hosted sandbox payment.

## Repository

`app/` contains the Next.js application, database migrations and tests. [Architecture](docs/ARCHITECTURE.md) describes the payment and licence flow. Deployment configuration is in `render.yaml`.

## License

[MIT](LICENSE). The existing copyright and third-party notices are preserved.
