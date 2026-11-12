# UseRight app

1. Install: `npm install` (Node 22.12+).
2. Migrate: `npm run db:migrate` — local PGlite in `./.pglite` (override with `PGLITE_DIR`); set `DATABASE_URL` (Supabase) to use postgres.js instead.
3. Seed: `npm run db:seed` — Imani, Northwind and its paid v1; a second run writes nothing.
4. Test: `npm test` (vitest, in-memory PGlite, `AI_PROVIDER=fixture`). Typecheck: `npm run typecheck`.
5. Dev server: `CREATOR_TOKEN=<any secret> npm run dev`, open `/login`, sign in with that token, then use `/deals`, `/settings` and `/dev/intake` (to add requests). Scripts may send `Authorization: Bearer <token>`; every POST/PUT/PATCH must also carry an `Origin` header. Set `APP_ORIGIN=https://<your-domain>` in production: Origin must equal it (without it, Origin is compared to Host, dev only). Email-confirm links are never returned to the requester; the creator gets one from the deal room until outbound email exists. HTTP smoke test: `BASE=http://localhost:3000 CREATOR_TOKEN=... npx tsx scripts/smoke.ts`.

AI env: `AI_PROVIDER=fixture` (default; pick a fixture name such as `demo-dm` on `/dev/intake`), `gemini` (`GEMINI_API_KEY`, `AI_MODEL`, default `gemini-flash-latest`) or `openai_compat` (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`). Live test: `LIVE_AI=1 AI_PROVIDER=gemini GEMINI_API_KEY=... npx vitest run tests/live-ai.test.ts`. Fixtures: `npx tsx scripts/make-fixtures.ts`; demo image: `pwsh scripts/make-demo-dm.ps1`.
