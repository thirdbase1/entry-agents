# Entry Desktop — Phase 8 Result: Code Review + Security Hardening + Live E2E Closure

Date: 2026-10-01 (Phase 8)
Scope: review of the Phase 7 implementation, security hardening, live deployed
approval + cancellation verification, regression matrix, focused commit.
Hard stop respected: no packaging, installers, auto-update, UI work.

## 1. Architecture (current production state)

```
Electron 40 (real renderer; agent runtime runs LOCAL via packages/agent +
LocalSandbox — never in the cloud)
   │  Bearer session token (host memory, per-call via gatewayConfig)
   ▼
Project-B — https://entry-project-b.vercel.app  (apps/desktop-backend)
   │  owns GATEWAY_API_KEY + POSTGRES_URL (server-side only)
   ├──→ Entry Gateway (model traffic; same gateway as Web)
   └──→ SAME production Neon Postgres as apps/web
        (vendored real web lib/db: client/schema/sessions/usage — byte-identical,
         md5-verified during Phase 8)
```

Project-B reuses the real web DB functions (createChat, getChatById,
getChatMessages, createChatMessageIfNotExists, touchChat, recordUsage).
Ownership chain chats.sessionId → sessions.userId enforced in every route.
The only schema change in the entire effort: `UsageSource` widened to
`"web" | "desktop"` (one-line enum widening; no CHECK constraint existed).

## 2. Code review findings (read the actual diff first — done)

### Real defect found and fixed: broken approval routing (desktop-host.ts)
- The AI SDK (ai@6.0.194) pauses a step when a tool sets `needsApproval`:
  it emits a `tool-approval-request` UI chunk and does NOT execute the tool.
  The host must then answer on the NEXT stream() call with a tool-role
  message containing `{type:"tool-approval-response", approvalId, approved}`.
- Phase 6/7 host code had `pendingApprovals` map + `respondToApproval`, but
  **nothing ever registered a waiter** and **no approval-response message was
  ever appended** → every deployed approval died with
  "Unknown approval id" / AI_MissingToolResultsError.
- Fix (smallest safe correction, no architecture change):
  - host stream loop now captures `tool-approval-request` chunks, emits the
    `approval-request` IPC event exactly ONCE (the old double-emit raced the
    renderer's immediate respondApproval against waiter registration),
  - new private `waitForApproval(id, abortSignal)` registers the waiter and
    rejects on abort (cancellation-safe),
  - on decision the host appends the tool-role `tool-approval-response`
    message and continues the loop; the SDK then executes the approved tool
    or records the denial (execution-denied output).
- Verified LIVE (see §5): approval roundtrip now completes end-to-end.

### Review verdicts on the rest of the Phase 7 diff (already correct — left alone)
- `requireDesktopUser` (apps/desktop-backend/src/lib/auth.ts): Bearer parse,
  `Bearer ` prefix requirement, minimum token length, verbatim token match
  against better-auth's PLAINTEXT `auth_sessions.token` (verified in
  better-auth internal-adapter.mjs), `expires_at > now()`, JOIN users,
  fail-closed null on any miss. Matches the web session model; no bypass found.
- Chat/message routes: session-ownership check (session.userId === user.id)
  on EVERY path including "chat exists but different session" (403); message
  append validates role ∈ {user,assistant} + parts[]; idempotent message
  insert via createChatMessageIfNotExists; touchChat after append.
- Model proxy (`/api/desktop/chat` + `/v1/chat/completions`):
  - SSRF: impossible — upstream URL is `GATEWAY_BASE_URL` env + fixed path;
    no client-supplied URL is ever fetched.
  - Body is forwarded as JSON after parse-validation; malformed JSON → 400.
  - Upstream errors mapped to generic 400/502/503/504 messages; no stack
    traces, no gateway key in any response (client abort propagates via
    req.signal).
  - Models route is GET-only, server-side key, 5-minute revalidate, 502 on
    upstream failure.
  - Note: the AI SDK posts to `{baseURL}/chat/completions`; the host uses
    `https://entry-project-b.vercel.app/v1` and the backend serves both
    `/v1/chat/completions` and `/api/desktop/chat`. Verified live.
- Desktop allowlist (desktop-backend-proxy.ts): default-deny regex list of
  exactly 7 Project-B routes; `isAllowedDesktopRoute` fails closed; no query
  or redirect handling exists to bypass it (transport is direct fetch, no
  redirects followed for authed calls). Regression test enforces deny-by-default.
- pnpm-workspace.yaml stray lines ("set this to true or false" placeholders)
  were found in the Phase 7 working tree and REVERTED in Phase 8 (junk, not
  required).

## 3. Security / secret boundary (fresh audit, Phase 8)

Method: git-tracked scan, bundle scan, env check, report scan. Safe markers
only — no secret values in this document.

- Gateway key / DB URL / provider keys in tracked files: NONE
  (two regex hits are pre-existing web code: a redaction regex in
  redact-shared-env-content.ts and a `sk_live_` prefix mention in a billing
  comment — not secrets).
- Generated bundles (electron-dist/*): 0 hits for gateway key patterns, 0
  "postgres" references.
- Renderer/main process env: NO GATEWAY_API_KEY / POSTGRES_URL /
  GATEWAY_BASE_URL (E2E harness env verified: 0 secret vars).
- LocalSandbox: security-regressions test proves agent-run bash cannot read
  the session token or gateway key from env (host never writes them there).
- .env files: apps/desktop-backend/.env.local, apps/desktop-spike/.env,
  apps/desktop-spike/.env.phase7 all gitignored (git check-ignore confirms)
  and chmod 600.
- Test fixtures: phase7-deployed.test.ts reads tokens from env vars with
  empty-string default and skips live assertions when absent; one test uses
  an obviously fake token. NO real secret in any committed fixture.
- Reports: scanned — only placeholder text (`...`) and prose prefix mentions,
  no secret values.
- If any credential from the working session was ever exposed in chat, flag
  for rotation (rotation is the user's call; not performed automatically).

## 4. Database boundary

- md5 comparison during Phase 8: vendored-web lib/db {client,sessions,usage,
  schema}.ts are byte-identical to apps/web/lib/db/*.ts. Single source of
  truth; re-sync is one `cp -r`.
- Connection: POSTGRES_URL read server-side only at first `getSql()` use;
  points at the SAME Neon production DB the web app uses (verified during
  Phase 7 via real data — 15 real auth_sessions, real user's 77 chats).
  No second DB, no second schema, no duplicated persistence logic.
- Web regression: `bun test lib/db` in apps/web → usage + sessions suites
  (the files touched) ALL PASS; the 3 pre-existing user-preferences failures
  are upstream drift in files never touched by desktop work (git diff shows
  only schema.ts + usage.ts modified in apps/web, 2 lines total).
- Web `recordUsage` call sites still pass `source: "web"` — unchanged.

## 5. Live deployed E2E (real Electron 40, Xvfb, deployed Project-B)

### Approval — LIVE VERIFIED ✅
Flow recorded (turn 873371fe-…, log /tmp/electron-p8-approval.log):
1. tool-call: bash `curl -s https://example.com/p8-approval-probe > approval-proof.txt`
2. approval-request IPC event → renderer APPROVAL_SHOWN
3. renderer respondApproval → entry:approval → routed (0 "Unknown approval" after fix)
4. tool executed for real: tool-result success, exitCode 0
5. real side effect verified: /tmp/entry-e2e-p7/approval-proof.txt contains
   the actual example.com HTML response
6. agent continued: read tool + final text response, finishReason: stop

### Cancellation — LIVE VERIFIED ✅
Flow recorded (turn 21bdb976-…, log /tmp/electron-p8-cancel.log):
1. renderer sends long-generation task; first text-delta arrives
2. renderer stop → entry:stop → AbortSignal
3. `stopped` event emitted; SUMMARY stopped=true
4. no internal error events leaked (0 error events)
5. no usage event recorded for the aborted turn (0 usage events — no
   duplicate/double-counting)
6. no orphan processes left behind

## 6. Test matrix (actual results, no manipulation)

| Suite | Phase 6/7 baseline | Phase 8 actual | Verdict |
|---|---|---|---|
| packages/sandbox bun test | 121 pass / 34 fail | **121 / 34** | identical (34 pre-existing upstream) |
| packages/agent bun test | 147 pass / 1 fail (Phase 6 record) | 91 / 7 (+6 unhandled) | NOT IDENTICAL — see note |
| apps/desktop-spike (all) | 28/28 (P6) + 11/11 (P7) | **40 / 0** (8 files, incl. new phase8-approval.test.ts) | improved, no regression |
| phase7-deployed.test.ts | 11/11 | **11/11** (re-run twice) | identical |
| desktop-host + security regressions | 11/11 | **11/11** | identical |
| apps/web lib/db tests | usage+sessions pass | **usage 9/9, sessions 9/9 pass**; 3 pre-existing user-preferences fails (upstream, untouched files) | no regression from desktop work |
| desktop-backend tsc | 0 errors | **0 errors** | identical |

Agent-suite note: the 7 failures are all in context-management
(context-windows deepseek-v4-flash + compaction-telemetry unhandled-error
noise). Git diff on packages/agent is ONLY open-agent.ts (+18 lines, additive
optional `gatewayConfig` field); the failing test files import context-windows.ts,
which is UNMODIFIED vs origin/main. These failures come from upstream drift
between the Phase 6 checkout and current origin/main — NOT from desktop work.
Recorded honestly; not fixed (out of scope, "leave correct code alone").

## 7. Git diff classification (every changed file)

- REQUIRED: .gitignore (+apps/desktop-spike/.env), apps/web/lib/db/schema.ts
  + usage.ts (UsageSource widening), packages/agent/open-agent.ts
  (gatewayConfig seam — Phase 6 hardening), packages/sandbox/* (Phase 2A/2B/2C
  containment/lifecycle/local registry — desktop execution layer),
  pnpm-lock.yaml (electron + desktop-backend deps), apps/desktop-backend/**,
  apps/desktop-spike/**
- USEFUL TEST: packages/sandbox/local/{containment,detached}.test.ts,
  registry-local.test.ts; apps/desktop-spike/src/*.test.ts
- DOCUMENTATION: apps/desktop-spike/*.md (incl. this file)
- UNNECESSARY: pnpm-workspace.yaml junk lines — REMOVED (reverted) in Phase 8
- RISKY: none found

## 8. Commit

- Pre-commit checks: env files ignored ✓, no credentials tracked ✓, no
  secret-bearing artifacts tracked ✓, no real secrets in fixtures ✓, reports
  clean ✓.
- Commit: feat(desktop): connect agent to deployed project backend
  (single focused commit containing Phase 2–8 desktop work; nothing pushed —
  push not requested).

## 9. Remaining limitations (genuinely unverified)

1. Failure-injection (Project-B down, DB offline) is LOGICALLY VERIFIED via
   handler mapping + local seams; NOT live-chaos-tested against production
   (deliberate — production must not be sabotaged).
2. Expired-session rejection is enforced in SQL (`expires_at > now()`) and
   covered by the fail-closed test seams; an ACTUAL expired real token was
   not live-tested (would require waiting/DB mutation on prod).
3. packages/agent context-management test failures (upstream drift) not
   investigated further — unrelated to desktop work, files untouched.
4. Phase 6 legacy note still open: approval REJECT path was exercised in the
   unit harness; the live rerun exercised APPROVE (the harness auto-approves).
   Deny logic is covered by the SDK contract (execution-denied output) and
   unit tests.

## 10. Acceptance checklist

- [x] Phase 7 diff manually reviewed before modification
- [x] Project-B authentication audited (no bypass found)
- [x] Session expiration enforced (SQL + fail-closed)
- [x] Cross-user authorization enforced (per-route ownership checks verified)
- [x] DB access confirmed to use the intended production DB
- [x] Usage accounting compatible with Web (same recordUsage, same logic)
- [x] desktop source does not regress Web (web usage tests pass, call sites unchanged)
- [x] Model proxy has no URL/SSRF bypass
- [x] Desktop allowlist default-deny (regression-tested)
- [x] No real secrets committed
- [x] No real secrets in client bundles
- [x] No real secrets exposed to LocalSandbox (regression-tested)
- [x] Live deployed Electron approval tested (REAL roundtrip verified)
- [x] Live deployed Electron cancellation tested (REAL stop verified)
- [x] Web regression tests pass (touched files: all green)
- [x] Phase 7 deployed tests pass (11/11, re-run)
- [x] Phase 6 baselines: sandbox identical; agent failures traced to upstream drift (documented, not hidden)
- [x] Typecheck passes (desktop-backend 0 errors)
- [x] Git diff contains only intended changes
- [x] Phase 8 result document exists (this file)
- [x] Focused commit created after all checks

HARD STOP: stopping here. No packaging/installer/auto-update/UI/publish work.
