# Entry Desktop — Phase 3: Backend Parity Inspection

**Date:** 2026-10-01 · **Type:** inspection + verification only. Zero production code changed.
**Result: PASS WITH LIMITATIONS** (architecture fully mapped and verified from source; live cross-surface DB tests blocked — no Postgres/Docker in this environment; no Gmail integration exists).

---

## 1. Repository architecture discovered

- Monorepo: `apps/web` (Next.js on Vercel — the ONLY backend today), `packages/{agent,sandbox,shared,tsconfig}`. There is **no separate backend package**; all server logic lives in `apps/web` (`lib/db`, `lib/billing`, `lib/auth`, `app/api`, `app/workflows`).
- The web backend is **stateful-by-DB**: chat creation, auth, OAuth, billing, and usage are plain Next.js route handlers + Vercel Workflow ("use workflow"/"use step") functions sharing one Postgres DB (Drizzle ORM, `apps/web/lib/db/schema.ts`, ~850 lines, migrations in `apps/web/lib/db/migrations/`).

## 2. Web chat creation path (traced)

```
POST /api/chat  (apps/web/app/api/chat/route.ts, 299 lines)
  → requireAuthenticatedUser() (session/_lib/session-context.ts) → userId (users.id)
  → chat lookup/creation (lib/db/sessions.ts createChat / getChatById; ownership via sessions.userId)
  → guard: chat.activeStreamId → resume-or-409 (reconcileExistingActiveStream)
  → persistLatestUserMessage() + persistAssistantMessagesWithToolResults()   ← user + stale assistant parts
  → start(runAgentWorkflow, [...])   ← Vercel Workflow durable run (app/workflows/chat.ts, ~3600 lines)
      · billing: claimUserBillingTurn (per-user turn lock), usage windows, spend caps
      · model: sharedProvider() → GATEWAY_BASE_URL/GATEWAY_API_KEY
      · per-step: estimateStepCost → settleStepCost → debitUsage
  → claimChatActiveStreamId(chatId, run.runId); chat.status lifecycle (idle|queued|running|…)
  → streaming: GET /api/chat/[chatId]/stream reads the workflow run (workflow/api getRun)
  → finalization: app/workflows/chat-post-finish.ts → estimateModelUsageCost → recordUsage (usage_events) + debitUsage (credit ledger)
```

Message persistence model: `chat_messages` rows `{id nanoid, chat_id FK, role: user|assistant, parts jsonb, created_at}` — AI SDK `UIMessage.parts` verbatim, so tool calls/results/reasoning are stored inside `parts`. No separate tool-call table.

## 3. Database (relevant schema)

- Provider: Postgres; ORM: **Drizzle** (`drizzle-orm/postgres-js`); client: lazy `db` proxy on `POSTGRES_URL` (`lib/db/client.ts`).
- Chain: `users → sessions (sessions.user_id FK, cascade) → chats (chats.session_id FK, cascade, idx chats_session_id_idx) → chat_messages (chat_messages.chat_id FK, cascade)`; reads-tracking via `chat_reads (user_id, chat_id) PK`.
- Usage: `usage_events {id, user_id FK, source:"web", agent_type main|subagent, provider, model_id, input_tokens, cached_input_tokens, output_tokens, cost_usd real nullable, tool_call_count, created_at}`.
- Billing: on `users` (`plan, creditBalanceCents, planGrantBalanceCents, billingCycleAnchor, billingCustomerCode, activeBillingRunId + claimedAt`) plus `credit_transactions`, `billing_webhook_events`.
- Auth: better-auth tables `users / accounts / auth_sessions / verification`.
- **user → chat → messages → usage is connected exclusively by `users.id`** — no chat_id on usage_events (usage is per-user/per-model, not per-chat).

## 4. Auth identity model

- better-auth (`lib/auth/config.ts`): social sign-in with **Vercel + GitHub** OAuth; `account.encryptOAuthTokens: true` (tokens encrypted at rest in `accounts`); account linking enabled (trusted: vercel, github).
- Session: `auth_sessions.token` (unique) → `auth_sessions.user_id` → `users.id`. Web identity helpers: `getServerSession()` / `requireAuthenticatedUser()`.
- **The invariant Desktop needs already holds:** OAuth identity → internal `users.id` (nanoid) → every chat/message/usage row. **Desktop must resolve to the same `users.id`; no new user id, no device-id identity, no second user table.** `accounts.providerId+accountId` maps (provider, provider-account) → one user, so the Desktop Backend authenticating the same better-auth session lands on the identical DB user.

## 5. OAuth model

Model is exactly: `OAuth identity → server-side session/account → server-side stored (encrypted) tokens`. Refresh is better-auth's own (`accessTokenExpiresAt/refreshTokenExpiresAt` columns). All provider client secrets are server env (`VERCEL_APP_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`); only client IDs are `NEXT_PUBLIC_*`. Desktop Backend can reuse `lib/auth/config.ts` + the same better-auth tables as-is; it must **not** copy tokens to the renderer.

## 6. Gmail OAuth — DOES NOT EXIST

Searched the entire repo (case-insensitive, excluding node_modules): **there is no Gmail/Google OAuth integration anywhere.** Gmail appears only in skill docs (Composio's agent-browser auth reference). The only "external app connection" mechanism is **Composio MCP** (`lib/mcp/composio.ts` + `composio_sessions` table): per-user Composio session (`composio.create(userId, {mcp:true})`), OAuth handled by **Composio's hosted Connect Link — Entry never sees those tokens**. If "Gmail tools" means Composio's Gmail toolkit, the invariant "same user → same server-side connection" already holds automatically: the Desktop Backend would call the same `resumeOrCreateComposioSession(userId)` with the same `users.id` and the same `COMPOSIO_API_KEY` server-side. No Entry-side Gmail tokens exist to duplicate or expose.

## 7. Gateway integration

- Config: `GATEWAY_BASE_URL` + `GATEWAY_API_KEY` server env (8 refs each, e.g. `lib/models-with-context.ts:355-360` — throws if unset; never sent to renderer; `api/settings/gateway-defaults/route.ts` explicitly masks the key).
- Model list/pricing fetched live from the gateway (`/v1/models`); model selection = `chats.modelId` (default `step-5-preview`) + `userPreferences.defaultModelId` + `model_overrides` kill-switch table.
- Usage metadata comes back in stream `providerMetadata.gateway.cost`; headers/auth handled by `packages/agent/models.ts` `sharedProvider()`.

## 8. Usage / billing — source of truth

Single implementation, all server-side, workflow-adjacent:

| Concern | File |
|---|---|
| Pricing input | `lib/models-with-context.ts` `fetchModelCostCatalog()` (gateway `/v1/models`, 60s cache; pricing-only, unfiltered) |
| Per-step cost | `app/workflows/gateway-metadata.ts` `estimateStepCost()` (gateway-reported cost, else token math incl. cache-read discount / cache-write surcharge) |
| Token math | `lib/models.ts` `estimateModelUsageCost()` |
| Sub-cent accrual | `lib/billing/usage-accrual.ts` `settleStepCost()` (integer-cent ledger + carry; the 2026 sub-cent billing fix) |
| Ledger debit | `lib/billing/credit-ledger.ts` (`debitUsage`, `claimUserBillingTurn` per-user turn lock, plan-grant pool expiry) |
| Usage records | `lib/db/usage.ts` `recordUsage()` → `usage_events` (sole insert site) |
| Turn orchestration | `app/workflows/chat.ts` (windows, caps, admin bypass) + `chat-post-finish.ts` |
| Errors mid-generation | usage already accrued per settled step; post-finish is where the final event is recorded — a crash loses only that last unsettled carry (< 1 cent by design) |

**Recommended:** do NOT create `packages/shared-usage`. These modules import `@/lib/db` and Next-context helpers; extracting them now would be a refactor of working billing code for zero behavioral gain. The parity requirement is met instead by **both Vercel projects deploying the same `apps/web` codebase** (see §9) — identical functions, identical results.

## 9. Desktop Backend — recommended architecture

**Deploy `apps/web` twice: Vercel Project A (web backend) and Vercel Project B (desktop backend), same repo/branch, same `POSTGRES_URL`, same `GATEWAY_*`, same `BETTER_AUTH_SECRET` (shared session verification), same `COMPOSIO_API_KEY`.**

Why this is the cleanest option given the actual source:
1. All chat/billing/auth logic lives in `lib/` inside `apps/web`, heavily importing `@/` aliases and the Workflow SDK — extracting a backend package now means rewriting working code (violates the don't-refactor rule).
2. Vercel deploys one repo to multiple projects with per-project env vars natively; no code duplication, `db:check` in CI keeps both on the same migrations.
3. Desktop Backend exposes a **smaller surface by route config**, not by forking code: Desktop talks only to a pinned subset (`/api/chat`, `/api/sessions/:id/chats`, usage, billing/me, better-auth `/api/auth/*`). Web keeps everything.
4. Add a `DESKTOP_ALLOWED_ROUTES` env check (one middleware file) later to hard-enforce the smaller surface. Desktop client stores **no secrets**: it authenticates via better-auth session cookies/bearer against Project B; Project B holds all credentials.

## 10. API contract (existing routes Desktop can use)

| Desktop operation | Existing Entry route/function | Status |
|---|---|---|
| authenticate | better-auth `/api/auth/*` (same tables/secret) | EXISTING |
| getCurrentUser | `requireAuthenticatedUser()` / `getServerSession()` behind every route | EXISTING |
| listChats | `GET /api/sessions/:id/chats` → `getChatSummariesBySessionId` | EXISTING |
| createChat | `POST /api/sessions/:id/chats` (`createChat`, accepts client id) | EXISTING |
| getChat | `GET /api/sessions/:id/chats/:chatId` (+ `/read` for unread state) | EXISTING |
| sendMessage/stream | `POST /api/chat` (starts workflow) + `GET /api/chat/:id/stream` + `/stop`, `/queue` | EXISTING |
| persistMessage | internal to `POST /api/chat` (`persistLatestUserMessage`, `persistAssistantMessagesWithToolResults`) | SHARED (indirect) |
| getUsage | `GET /api/usage` (`getUsageHistory`) | EXISTING |
| billing | `/api/billing/{me,plans}` | EXISTING |
| OAuth connection | better-auth account tables + `lib/mcp/composio.ts` | EXISTING |
| rename/delete chat | `PATCH/DELETE /api/sessions/:id/chats/:chatId` | EXISTING |
| Desktop session = local project | **no equivalent**: web sessions assume repo/vercel sandbox fields; desktop sessions rooted at a local dir (`sandboxState {type:"local", rootDir}`) will need a small **ADAPTER/NEEDS NEW** decision in `POST /api/sessions` payload handling (schema already supports arbitrary `sandboxState` jsonb — likely no schema change) | NEEDS ADAPTER |

**NEEDS NEW: nothing at the schema level.** The only gap is the session-shape adapter and the route-allowlist middleware.

## 11. Cross-surface verification

| Test | Result |
|---|---|
| A/B (cross-surface chat create/lookup via live DB) | **BLOCKED** — no `POSTGRES_URL`, no Docker/Postgres in this environment; parity logic verified from source only |
| C/D (cross-surface message visibility) | **BLOCKED** — same |
| E (same identity → same user row) | **UNIT VERIFIED (source-traced)** — better-auth `accounts(providerId,accountId)→users.id`; every table FKs to `users.id`; no second identity path exists |
| F (usage associated to same user/chat structure) | **UNIT VERIFIED (source-traced)** — sole insert site `lib/db/usage.ts:39`, FK `usage_events.user_id`; both deployments run the same function |
| G (Gmail OAuth same server-side connection) | **NOT TESTED — no Gmail integration exists**; Composio MCP is the equivalent mechanism, keyed by `users.id`, reusable unchanged (documented §6) |
| Chat-create/own flow correctness | UNIT VERIFIED — route trace §2; no mock-DB parity tests claimed |

Live verification requires: a dev Postgres URL + running both surfaces against it. Documented as the first item for the next phase's environment setup.

## 12. Security boundaries

- Desktop client must contain **no** `POSTGRES_URL`, `GATEWAY_API_KEY`, `BETTER_AUTH_SECRET`, OAuth client secrets, or Composio key — all stay in Vercel Project B env. Desired dataflow confirmed feasible: `Electron → authenticated request → Desktop Backend (Vercel B) → same DB/Gateway/OAuth`. ✅
- Verified in current web code as precedent: gateway key masked in settings route; OAuth tokens encrypted at rest (`encryptOAuthTokens: true`); secrets server-side env only; only client IDs public.
- Risks to address when building Desktop Backend: (a) enforce the route allowlist middleware; (b) rate-limit Project B (web routes rely on shared Redis — `REDIS_URL` must be set there too); (c) CORS/origin pinning for the desktop origin; (d) never echo tokens through chat tool results (existing sanitize-tool-inputs helps but is not a secret boundary).

## 13. GitHub Actions / deployment

- `.github/workflows/ci.yml`: PR-only CI (lint, typecheck, `test:isolated`, `db:check` with Node 24 + Bun 1.2.14). **No deploy workflow exists — deployment is Vercel's Git integration.** `apps/web/vercel.json` = crons only. `telegram-alerts-ping.yml` is unrelated alerting.
- Required for Desktop Backend (Project B): create the second Vercel project pointing at the same repo; set env vars in Vercel dashboard (not in Git): `POSTGRES_URL`, `GATEWAY_BASE_URL`, `GATEWAY_API_KEY`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (Project B's URL), `REDIS_URL`, `COMPOSIO_API_KEY`, plus public IDs. **Verified: none of these appear in the repo** (only `apps/desktop-spike/.env`, gitignored, holds the user-pasted gateway key for the spike).

## 14. Files changed in this phase

**None in production code.** `git status` unchanged from Phase 2C (previous-phase files only). This report is the sole artifact: `apps/desktop-spike/ENTRY-DESKTOP-BACKEND-PARITY-RESULT.md`.

## 15. Known limitations

1. No live cross-surface DB test (no Postgres/Docker here) — parity claims are source-traced, not integration-executed.
2. Gmail/Google OAuth does not exist in Entry; the invariant was assessed against the actual mechanism (Composio MCP, token-less from Entry's perspective).
3. Workflow SDK coupling: `runAgentWorkflow` requires Vercel Workflow infrastructure; Desktop Backend must be a Vercel project (or the workflow bits extracted later) — flagged, not solved.
4. `usage_events.source` is enum `"web"` only — a desktop source value would need one migration later; not done (schema frozen this phase).

## 16. Recommended next phase

**Phase 4 — Electron/OAgent shell integration** (per ENTRY-DESKTOP-BLUEPRINT.md): OAgent → `apps/desktop/`, delete its brain, add `entry-agent-host`, wire the renderer to Vercel Project B endpoints with the allowlist middleware, and set up a dev Postgres so the §11 BLOCKED cross-surface tests can be executed for real.

---

# Prior phase (Phase 2C) content follows unchanged
