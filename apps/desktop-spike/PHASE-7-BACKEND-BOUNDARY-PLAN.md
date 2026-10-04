# Phase 7 — Backend Boundary & Project-B Plan

**Date:** 2026-10-01 · Status: inspection complete, implementation plan locked

## 1. Current architecture

| Surface | Where it lives today |
|---|---|
| Web app + backend | `apps/web` (Next.js) → deployed as Vercel project `entry-agents` |
| Desktop backend (local stub) | `apps/desktop-spike/src/desktop-backend-proxy.ts` + e2e test stub (Phase 6) |
| Desktop runtime | `apps/desktop-spike/src/{desktop-host,entry-agent.handler,entry-electron-main}.ts` |
| Gateway | `https://entry-gateway-six.vercel.app/` (Express, separate Vercel project `entry-gateway`) |
| DB | Shared Postgres; all tables owned by `users.id`; ownership chain `chats.sessionId → sessions.userId` |

## 2. KEY FINDING — Project-B already exists (deployed)

A standalone desktop backend **is already deployed** as Vercel project
**`entry-desktop-backend`** (READY deployments; domain `entry-desktop-backend.vercel.app`,
alt domain `desktop.entry-agents.dev`), with source at **`entry-retired/desktop-backend/`**
(a standalone Next.js app, unrelated to the Tauri app in that repo).

Verified live behavior:
- `GET /api/desktop/models` → 403 without desktop headers, 401 with bad bearer — the
  allowlist/CORS + session auth is enforced **in production**.
- Routes present: `auth/{authorize,callback}`, `device/{start,poll}`, `chat` (gateway
  proxy), `latest`, `me`, `models`, `signout`.
- Env (decrypted-inspectable only by the team): `DATABASE_URL`, `GATEWAY_API_KEY`,
  `GATEWAY_BASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_*`,
  `VERCEL_CLIENT_*`, `GITHUB_PROXY_TOKEN` — all server-side, none client-safe.

Its auth model (verified from source): **no new auth system** — the Web app (better-auth)
mints `auth_sessions` tokens; a pairing/device flow (`desktop_device_codes` runtime table)
exchanges a one-time code for the user's existing session token; every desktop request
sends `Authorization: Bearer <auth_sessions.token>`, looked up with `expires_at > now()`
joined to `users`. CORS gates on Origin + `x-entry-desktop: tauri` header.

## 3. Local proxy responsibilities vs existing Web/Project-B backend

| Responsibility | Local stub (Phase 6) | Web backend | Project-B (deployed) |
|---|---|---|---|
| Auth/session | none (test token) | better-auth + GitHub/Vercel OAuth | reads `auth_sessions` (no minting) |
| Model proxy | `/v1/chat/completions` forward | `/api/chat` (Vercel Workflow) | `POST /api/desktop/chat` (plain fetch, no Workflow) |
| Model catalog | hardcoded | `GET /api/models` | `GET /api/desktop/models` (+balance) |
| Chat persistence | via real lib/db in tests | lib/db functions | **GAP — see below** |
| Usage | not implemented locally | `recordUsage` in `chat-post-finish` workflow | **GAP — see below** |
| Device pairing | none | n/a | `device/{start,poll}` + `auth/*` |

## 4. Gaps that Phase 7 must close

**Gap 1 — chat persistence on Project-B.** The deployed backend has no chat
routes. It shares the DB read-only. We add `desktop-backend/app/api/desktop/chat/`
routes (create/append/read) that call the **same `lib/db/sessions.ts` functions**
as Web (chats createChat/createChatMessage/getChatMessages, ownership via
`chats.sessionId → sessions.userId`). This is the Phase 6 `shared-db.test.ts` flow,
moved behind the deployed API.

**Gap 2 — desktop usage source.** `usage_events.source` is an enum `["web"]`
(schema + column default; **no SQL CHECK constraint** — verified in live DB). The
smallest safe change: widen the Drizzle enum to `["web","desktop"]` in
`lib/db/schema.ts` (one line; no migration needed since no SQL constraint exists),
and reuse `recordUsage` unchanged. Project-B then records desktop usage through the
**same accounting function** — no second calculator.

**Gap 3 — desktop host must target Project-B.** `desktop-host.ts` keeps per-call
`gatewayConfig` (Phase 6 security) but its `baseURL` becomes
`https://entry-desktop-backend.vercel.app/api/desktop/chat` semantics; the desktop
sends `Bearer <auth_sessions token>` + desktop headers. The Gateway key stays in
Project-B env only.

## 5. Required endpoints (final contract in PHASE-7-BACKEND-API.md)

- `POST /api/desktop/device/start` · `GET|POST /api/desktop/device/poll` — pairing
- `GET /api/desktop/models` — catalog + balance
- `POST /api/desktop/chat` — gateway proxy (streaming-capable passthrough)
- `POST /api/desktop/chats` · `POST /api/desktop/chats/:chatId/messages` ·
  `GET /api/desktop/chats/:chatId` — chat persistence via shared lib/db functions (NEW)
- `POST /api/desktop/usage` — recordUsage via shared function (NEW)

## 6. Secret ownership (env names as found in the repo)

```
DATABASE_URL          server-only (Project-B)
GATEWAY_API_KEY       server-only (Project-B)
GATEWAY_BASE_URL      server-only (Project-B)
BETTER_AUTH_SECRET    server-only (Web + Project-B; Project-B only validates, never mints)
GITHUB_CLIENT_SECRET  server-only (Web; Project-B reuse of same OAuth app)
VERCEL_CLIENT_SECRET  server-only (Web)
Client-safe: NEXT_PUBLIC_GITHUB_APP_SLUG, NEXT_PUBLIC_GITHUB_CLIENT_ID,
             NEXT_PUBLIC_SITE_URL, verifyUrl/deviceCode (one-time, expiring)
```

## 7. Security risks & mitigations

- Session token on the desktop = full account session → mitigated by pairing flow
  (one-time code, 15-min expiry) and future short-lived scoped tokens.
- CORS allowlist currently requires `x-entry-desktop: tauri` header + Tauri origins →
  desktop (Electron) sends the same header; Electron's `Origin` is `file://` → we
  extend `ALLOWED_ORIGINS` with the Electron origin(s) (smallest change).
- Secrets never in: renderer, preload, sandbox env, bundles (Phase 6 regression tests
  keep guarding; new Phase 7 cases cover Project-B responses).

## 8. Exact files expected to change

- `entry-retired/desktop-backend/` (via GitHub API on `entry-retired` repo):
  + `app/api/desktop/chats/route.ts` (create chat)
  + `app/api/desktop/chats/[chatId]/route.ts` (read chat+messages)
  + `app/api/desktop/chats/[chatId]/messages/route.ts` (append message)
  + `app/api/desktop/usage/route.ts` (recordUsage-compatible insert)
  + `lib/auth.ts` — extend ALLOWED_ORIGINS for Electron
- `entry-agents` repo:
  + `apps/web/lib/db/schema.ts` — `UsageSource` enum + "desktop" (1 line)
  + `apps/desktop-spike/src/desktop-host.ts` — target deployed Project-B
  + `apps/desktop-spike/src/*` — Phase 7 integration/security tests
  + `apps/desktop-spike/PHASE-7-*.md`, `ENTRY-DESKTOP-PROJECT-B-RESULT.md`

## 9. Deployment

Project-B = the existing Vercel project `entry-desktop-backend` (already linked:
`prj_fCj0XJMZfHtOuuXIglmuWOKcdzmU`). Deploy the updated `desktop-backend/` directory
with `vercel deploy --prod` from that directory (no secrets in CLI; env already set
in project settings). Existing Web deployment (`entry-agents`) untouched.
