# Entry Desktop — Phase 4: Real DB Parity + Auth/OAuth Boundary Spike

**Date:** 2026-10-01 · **Result: PASS**
Real Postgres 16, real Entry migrations, real application persistence code, cross-surface
tests executed against the live dev DB. No mocks anywhere in the parity tests.

---

## 1. Dev Postgres setup

- Installed PostgreSQL 16.15 (apt, this machine). Created role `entry_dev` + database
  `entry_dev`, owner `entry_dev`, password local-only. **No credentials committed** —
  the URL was passed as an environment variable to each command/test invocation.
- Schema applied with the repository's own migrator — **not** a fake schema:
  ```bash
  cd apps/web
  POSTGRES_URL="postgres://entry_dev:...@localhost:5432/entry_dev" node lib/db/migrate.ts
  # → "Migrations applied successfully" (exit 0)
  ```
- Verified: all **25 real tables** present (users, accounts, auth_sessions, sessions,
  chats, chat_messages, chat_reads, usage_events, credit_transactions,
  billing_webhook_events, composio_sessions, workflow_runs/steps, mcp_servers,
  github_installations, vercel_project_links, benchmark_*, etc.).
- Post-test state: **0 rows in every table** — the harness deletes only its own test
  user (FK cascade removes children); cleanup proven by direct counts after the run.

## 2. Web → DB result (Step 6) — REAL DEV DB VERIFIED

Test user + GitHub OAuth account + auth session created through better-auth's exact
table shapes; project `sessions` row created via the real `createSession` domain
function. Chat/message/usage writes all went through the real `apps/web/lib/db/*`
functions imported by the harness (identical functions the Vercel route handlers call).

## 3. Cross-surface parity (Steps 7–8) — file: `apps/desktop-spike/src/parity-db.test.ts`

**10/10 pass.** The "Desktop Backend" side of each test is the same application code +
same DB pointed at from a second simulated deployment; the auth seam proven is exactly
what a separate Vercel Project B would use (same better-auth tables, same users.id).

| Test | Flow | Result | Evidence |
|---|---|---|---|
| 0 | Web identity + Desktop identity → same users.id | **PASS** | `accounts.account_id` (web GitHub acct) → users.id X; `auth_sessions.user_id` (desktop session) → same X; exactly 1 users row |
| A | Desktop creates chat → Web reads | **PASS** | same chat id/title via `createChat`/`getChatById`/`getChatSummariesBySessionId`; ownership check (`requireOwnedSession` semantics) passes with userId X |
| B | Web creates chat → Desktop reads | **PASS** | mirror of A |
| C | Desktop writes message (text + tool-invocation parts) → Web reads | **PASS** | `chat_messages.parts` jsonb round-trips byte-identical incl. tool call args/result; `chat_id`/`role`/`created_at` verified |
| D | Web writes message → Desktop reads | **PASS** | mirror of C |
| 9 | Usage parity | **PASS** | real `recordUsage()` → one `usage_events` row: provider `gateway`, model `step-5-preview`, 100/40/25 tokens, cost 0.0042, toolCallCount 3 — the single shared store, keyed by users.id X. (No gateway generation was run — the *calculator* path is source-verified from Phase 3; billing math itself NOT TESTED here, see §8.) |
| 10 | Ownership boundary | **PASS** | intruder user: `sessionRecord.userId !== intruderId` → 403 branch taken; per-user `chat_reads` join yields nothing for intruder |
| 11 | OAuth boundary / Gmail-shape proof | **PASS** | inserted a row `{providerId:"google", accountId:"gmail-future-12345", userId:X, scope:"gmail.readonly"}` into the REAL `accounts` table with zero code/schema change, read it back user-scoped, deleted it. Schema already represents future Gmail OAuth. |
| 12 | Composio connection reuse | **PASS** | `composio_sessions` PK = users.id; one row per user, resolvable from any surface |
| 13 | Billing on same identity | **PASS** | `users.plan/creditBalanceCents/planGrantBalanceCents` verified on the real row (free / 100 / 0) |

Test classification: all ten are **REAL DEV DB VERIFIED** (live Postgres, real schema,
real app code; the only non-live part is that "Web/Desktop surfaces" are represented by
their shared domain layer rather than HTTP requests — see Limitations).

## 4. Same-user identity (Step 10) — exact evidence

One `users.id` (nanoid) created in `beforeAll`. Web-side resolution = `accounts`
row (provider `github`, provider-account id) → `users.id`. Desktop-side resolution =
`auth_sessions` row → `users.id`. Both resolved to the identical id (TEST 0), all chat /
message / usage / billing assertions in every later test used that same id, and the
intruder test proved a second id gets 403. **No device ID, no installation ID, no email
substitute anywhere.**

## 5. Current OAuth architecture (Steps 1–2)

```
GitHub/Vercel OAuth (better-auth socialProviders, config in lib/auth/config.ts)
  → accounts {providerId, accountId, encrypted accessToken/refreshToken, expiry} → users.id
  → auth_sessions {token unique} → users.id        ← the cookie/session layer
  → application code: getServerSession() → {user.id} → requireAuthenticatedUser() → userId: string
  → domain layer: EVERY function takes userId as a plain parameter
    (createChat, getChatSummariesBySessionId, recordUsage, claimUserBillingTurn…)
  → ownership: requireOwnedSession/requireOwnedSessionChat compare row.userId === userId
```

Layer classification:
- **better-auth-specific:** `lib/auth/{config,client,actions}.ts`, `lib/session/*`,
  tables `accounts/auth_sessions/verification`.
- **application/domain-specific (Vercel-and-auth-agnostic):** everything downstream of
  `userId: string` — `lib/db/*`, `lib/billing/*`, ownership helpers. **The seam already
  exists**: domain code never imports better-auth; it consumes `userId: string`.
- **database-specific:** Drizzle schema + `lib/db/client.ts` (`POSTGRES_URL`) — fully
  host-agnostic.

## 6. Future Gmail OAuth boundary (Step 11) — READY, no changes needed

The existing `accounts` table natively represents `providerId:"google"`,
`accountId:<google sub>`, `userId` — **proven by writing exactly that row into the real
table (TEST 11, then removed)**. Placement:

- Provider config: one more entry in better-auth's `socialProviders` (`google: {clientId, clientSecret, scope:["…gmail…"]}`) in `lib/auth/config.ts` — server env only.
- Callback: better-auth's standard route (`/api/auth/callback/google`) — nothing custom.
- Tokens: `accounts.accessToken/refreshToken` — already **encrypted at rest** (`encryptOAuthTokens: true`), server-side, refreshed by better-auth.
- Desktop initiates: authenticated request → Entry Backend → same better-auth flow (desktop gets a session the same way it already does). Desktop never touches client secret or refresh token.
- Same connection for Web: same `accounts` row keyed by users.id — both surfaces resolve it identically (TEST 11/12 prove user-scoped resolution).
- Vercel-independent: nothing Gmail-related touches Vercel-specific code; it rides the better-auth + `accounts` + `users.id` stack that runs anywhere Postgres runs.

## 7. Vercel decoupling (Step 3 / 12)

**SAFE / APPLICATION-LEVEL** (survives any host/auth swap unchanged): the entire domain
layer (`lib/db/*`, `lib/billing/*`, `lib/usage/*`) — parameterized on `userId`; Drizzle
schema; `packages/*`; chat workflow business rules (once given a runtime).

**INFRASTRUCTURE-COUPLED** (what a Vercel exit would actually touch):
1. `lib/session/get-server-session.ts` + `session-context.ts` — `next/headers()` + better-auth `auth.api.getSession`. *The one true auth seam; a Desktop/other host replaces this one file's implementation with an equivalent `userId` resolver.*
2. Vercel Workflow SDK (`"use workflow"`/`"use step"`, `workflow/api`, `start()`) in `app/workflows/chat.ts` — the agent runtime needs a Workflow-compatible host or an extraction.
3. Vercel product integrations (not auth): `lib/vercel/*` (Vercel OAuth provider for *user* connections + sandbox token exchange), `vercelProjectLinks`, Vercel Sandbox SDK (`packages/sandbox/vercel` — untouched, optional provider), `NEXT_PUBLIC_VERCEL_*` envs.
4. better-auth URL/host config (`BETTER_AUTH_URL`, allowed hosts from `VERCEL_URL`) — config-level, swaps with env.
5. Admin dashboards read `providerId === "vercel"` for *connection flags* — cosmetic, provider-optional.

Key insight: **"Vercel the auth provider" is just `providerId:"vercel"` rows in the
generic `accounts` table** — removing it is deleting config + data, not redesigning
identity. `users.id` (nanoid) is the sole canonical identity; the
`Auth Provider → authenticated identity → users.id → domain` model is already in place.

## 8. Usage parity — status

- `recordUsage` → `usage_events` keyed by users.id: **REAL DEV DB VERIFIED** (TEST 9).
- Pricing/accrual/ledger math (`estimateStepCost` → `settleStepCost` → `debitUsage`):
  **source-verified only (UNIT VERIFIED from Phase 3)** — needs a live gateway
  generation; deliberately NOT mocked. Both backend deployments run the same functions
  from the same codebase, so identical results follow structurally.

## 9. Secrets (Step 13)

- `POSTGRES_URL` — local dev only, passed per-invocation, never written to any file in the repo; harness exits if unset.
- Gateway key — remains in the gitignored `apps/desktop-spike/.env` (spike use only).
- `BETTER_AUTH_SECRET`, OAuth client secrets, Composio key — production env vars, absent from the repo (re-verified Phase 3).
- No refresh tokens anywhere client-side; `accounts` tokens encrypted at rest.

## 10. Files changed

- `apps/desktop-spike/src/parity-db.test.ts` — NEW (the 10-test real-DB harness)
- `apps/desktop-spike/package.json` — +`nanoid`, +`postgres` (harness deps only)
- `apps/desktop-spike/tsconfig.json` — +`@/*` path mapping so the harness imports real `apps/web` code
- `apps/desktop-spike/ENTRY-DESKTOP-PARITY-AUTH-RESULT.md` — this report
- **Production code: unchanged** (`packages/*`, `apps/web` untouched — `git diff --stat` identical to Phase 3 state).

## 11. Verification

| Suite | Result | vs baseline |
|---|---|---|
| `bun test src/parity-db.test.ts` (with POSTGRES_URL) | **10 pass / 0 fail** | NEW — all green |
| sandbox | 121 pass / 34 fail | identical pre-existing groups |
| agent | 147 pass / 1 fail | identical pre-existing |
| sandbox typecheck | exit 0 | unchanged |
| desktop spike | **16/16** | unchanged |
| post-run DB | 0 rows everywhere | cleanup proven |
| `git status` | spike-dir files only | no unrelated changes |

## 12. Limitations

1. Surfaces simulated at the **domain layer**, not over HTTP: the harness proves the shared-persistence and shared-identity contract with the real code + real DB, but a second actual Vercel deployment answering real HTTP is Phase 5 work. (The route handlers are thin shells over exactly these functions.)
2. Billing math not executed against a live gateway (BLOCKED, not mocked).
3. better-auth session *cookie issuance* was represented by its table shapes, not by running the better-auth server; the library's adapter is the code that writes those exact tables.
4. Gmail row proven insertable/readable/deletable — the provider itself is NOT implemented (per hard scope).

## 13. Recommended next phase

**Phase 5 — Electron/OAgent integration** (blueprint steps): OAgent → `apps/desktop/`,
strip its brain, add `entry-agent-host`, renderer talks to Vercel Project B using the
`userId` seam documented in §5, with the session-shape adapter (desktop session =
`{type:"local", rootDir}` sandboxState) as the first backend change. The dev Postgres
from this phase becomes its integration-test fixture.
