# Entry Desktop — Phase 5: Native Entry Agent Runtime + Secure Desktop Backend Boundary

**Date:** 2026-10-01 · **Result: PASS WITH LIMITATIONS**

The desktop agent runs natively (real `openAgent()` + real hardened `LocalSandbox`,
no Next.js / Vercel Workflow / Vercel Sandbox / web routes), and the Gateway
credential boundary is **proven live**: an Electron-style host authenticated a real
model turn against a Desktop-Backend stand-in that alone held the real gateway key —
the desktop-side process env never contained it.

---

## 1. Executive result — native runtime conclusion

**Yes: Entry's agent runs natively inside an Electron main process without Vercel
Workflow.** Proven end-to-end with the real gateway and a real model:

```
EntryAgentHost (plain Node = what Electron main embeds)
  → model request (Authorization: Bearer <desktop session token>)
    → Desktop Backend stub (holds GATEWAY_API_KEY server-side)
      → Entry Gateway (real, live)
        → model mimo-v2.6-flash:free streamed back
  → openAgent() executed the write tool through LocalSandbox
  → host-proof.txt created on the real filesystem, content verified byte-exact
  → real token usage surfaced from the gateway
  → cancellation (abort + sandbox.stop) verified
```

Desktop does **not** use Vercel Workflow. Workflow remains exclusively in
`apps/web/app/workflows/{chat,chat-post-finish}.ts` + the `/api/chat` route — untouched.

## 2. Dependency map (verified from source)

| Component | Verdict |
|---|---|
| `openAgent()` / ToolLoopAgent loop | **LOCAL/NATIVE** — pure `ai` SDK, no host coupling |
| All file tools (read/write/edit/grep/glob/bash/task/todo/skill) | **LOCAL/NATIVE** — operate via the injected `Sandbox` interface only |
| `LocalSandbox` (containment + detached procs) | **LOCAL/NATIVE** — node:fs + child_process |
| MCP toolset (`createMcpToolSet`) | **LOCAL/NATIVE** — caller-built ToolSet via `extraTools`; stdio transport works in any Node process; the existing Entry implementation exposes http/sse (host-owned lifecycle) |
| `sharedProvider()` model creation | **LOCAL with BACKEND transport** — takes explicit `{config:{baseURL,apiKey}}`; env-var fallback is the only coupling, and the desktop host repoints it |
| Approvals (`needsApproval` → `tool-approval-request` UI chunks) | **LOCAL/NATIVE** — host relays to renderer over IPC |
| Cancellation (`abortSignal` + `sandbox.stop()`) | **LOCAL/NATIVE** |
| Chat/message persistence | **BACKEND** — shared Postgres via Desktop Backend (Phase 4 proven) |
| Usage calculation + credit ledger | **BACKEND** — same functions, same DB; per-step usage streamed to the host is display-only |
| better-auth session issuance | **BACKEND** — host holds only a session token |
| Vercel Workflow, `runAgentWorkflow`, `/api/chat` | **WEB-ONLY** — never on desktop |
| Vercel Sandbox / vercel_cli / vercel_api tools | **VERCEL-SPECIFIC** — optional provider; without injected `vercel` context they throw a clear per-tool error, never crash the agent (verified mechanism in `open-agent.ts` callOptionsSchema comments + tool degradation) |
| github_cli without `github` context | **NEEDS ADAPTER (later)** — degrades to tool-level error today |

## 3. Secure model boundary (the critical requirement)

**Flow implemented and live-tested:**

```
Electron Agent
  │  sharedProvider() reads GATEWAY_BASE_URL + GATEWAY_API_KEY
  │  host swaps env for the duration of a send() and restores it in finally:
  │    GATEWAY_BASE_URL = <Desktop Backend>/v1
  │    GATEWAY_API_KEY  = <short-lived desktop session token>
  ▼
Desktop Backend  (authenticates the session token; 401 otherwise)
  │  holds the real GATEWAY_API_KEY (server-side env only)
  ▼
Entry Gateway → model → streamed back through the same chain
```

Live proof (`desktop-host-e2e.test.ts`): every request the backend received carried
`Bearer desktop-session-token-local-test` and **never** the real key; the desktop-side
`process.env.GATEWAY_API_KEY` was deleted before the turn and the host's
swap/restore-in-`finally` behavior is unit-tested (key survives a failed `send()`
byte-identical).

Known limitation (documented, honest): the env-var swap happens in the host process,
and `LocalSandbox.exec` inherits `process.env` — so **during an active model call** an
agent-run `env` command could read the session token. The token is short-lived,
user-scoped, revocable, and grants only backend-proxy access (no direct gateway/DB/OAuth
reach) — the real gateway key is never present. A hardened follow-up is a
`sharedProvider({config})`-based provider injection so no env var is touched at all;
`packages/agent/models.ts` already accepts it, but `openAgent.prepareCall` doesn't yet
thread a per-call config — flagged as the small upstream change for Phase 6, not done here.

## 4. LocalSandbox integration

The host creates it exactly through the registry:
`connectSandbox({type:"local", rootDir}, {allowedRoots})` → LocalSandbox with Phase 2A
containment + Phase 2B detached-process lifecycle. Verified in host tests: escape
attempts rejected, in-root read/write works, `execDetached`/`killCommand` work through
the host, `stop()` cleans up. **No silent Vercel fallback is possible** — the registry
throws `UnsupportedSandboxProviderError` for unknown types. One additive production
change was required: `ConnectOptions.allowedRoots` (factory.ts) + forwarding cast
(registry.ts) — previously `allowedRoots` was unreachable through `connectSandbox`.

## 5. IPC contract (implemented in `desktop-host.ts`)

- **Requests:** `send{text}`, `approval{approvalId,approved,reason}`, `stop`
- **Events:** `turn-started`, `text-delta`, `reasoning-delta`, `tool-call`,
  `tool-result`, `tool-error`, `approval-request`, `usage`, `error`,
  `turn-finished`, `stopped` — all plain JSON, mapper is a pure function
  (`mapChunkToIpcEvents`) fully unit-tested (incl. non-desktop chunks → `[]`).
- Approvals mirror the web client's `addToolApprovalResponse({id, approved, reason})`
  semantics; approval-requested turns pause the loop (verified: loop breaks on
  `finishReason !== "tool-calls"`).
- The renderer owns none of the runtime; these types map 1:1 onto OAgent's
  `oagent:event` / `oagent:permission_response` preload surface (inspected).

## 6. Multi-turn behavior

`openAgent` is constructed `stopWhen: stepCountIs(1)` — one `stream()` = one model
step. The host therefore runs an explicit outer loop (mirroring
`runAgentWorkflow`'s `for step…` in web): stream a step → append `stream.response`
messages (authoritative, includes tool results) → repeat while
`finishReason === "tool-calls"`, cap 50 steps. The live E2E test exercised a real
multi-step turn (model → tool call → tool result → model → final text).

## 7. Desktop chat persistence & auth

Unchanged from Phase 4's live-DB proofs: desktop creates/reads chats and messages in
the shared schema via the shared domain functions; the authenticated identity is the
web `users.id`; the domain layer keeps receiving `userId: string` with zero better-auth
imports. Re-ran the Phase 4 parity suite after this phase's changes: **10/10 still
pass**. The Desktop Backend remains "apps/web deployed twice" (Phase 3 recommendation).

## 8. MCP

`extraTools` is the designed injection point; the host accepts a caller-built toolset.
Entry's MCP implementation supports http/sse transports host-side (stdio via the same
`@open-agents/agent` machinery in any Node process). Not exercised against a live MCP
server in this phase — **NOT TESTED**, no fake coverage.

## 9. Security summary — where every secret lives

| Secret | Location |
|---|---|
| GATEWAY_API_KEY (real) | Desktop Backend env + Web Backend env only. Never in the desktop process (live-tested), never in Git (verified: `git grep` clean; only gitignored `apps/desktop-spike/.env` for tests) |
| Desktop session token | Ephemeral, host memory only, swapped in/out of env per call |
| POSTGRES_URL / BETTER_AUTH_SECRET / OAuth client secrets / Composio key | Backend env only |
| OAuth/refresh tokens | `accounts` table, encrypted at rest, server-side |
| Renderer | Receives only IPC events; no secrets, no DB, no agent runtime |

## 10. Files changed

**Production (packages/sandbox — minimal, additive):**
- `packages/sandbox/factory.ts` — `ConnectOptions.allowedRoots?: string[]` (+doc)
- `packages/sandbox/registry.ts` — forward options cast to `LocalSandboxConnectOptions`

**Desktop harness (apps/desktop-spike, untracked app dir):**
- `src/desktop-host.ts` — NEW: EntryAgentHost + IPC event mapper + usage accumulator (~350 lines)
- `src/desktop-host.test.ts` — NEW: 7 tests (adapter purity, sandbox containment via host, detached lifecycle, env swap/restore security, turn lifecycle)
- `src/desktop-host-e2e.test.ts` — NEW: 4 live tests incl. real-gateway end-to-end
- `ENTRY-DESKTOP-NATIVE-RUNTIME-RESULT.md` — this report

## 11. Tests — exact commands and results

```bash
# Unit/integration (no gateway needed)
bun test src/desktop-host.test.ts                    # 7 pass / 0 fail

# LIVE end-to-end (real Entry Gateway via backend stub)
set -a && source .env && set +a
SPIKE_MODEL=mimo-v2.6-flash:free bun test src/desktop-host-e2e.test.ts
  # 4 pass / 0 fail:
  #  ✓ host → backend → gateway → model → write tool → real file (9.5s)
  #  ✓ real usage counts from gateway (inputTokens > 0)
  #  ✓ cancellation aborts the turn ("stopped" event)
  #  ✓ credential boundary: backend saw only the session token

# Regressions (all at known baselines)
bun test src/parity-db.test.ts                       # 10/10 (Phase 4 suite)
bun test packages/sandbox/local packages/sandbox/registry*.test.ts
  # 53 pass / 4 fail — the identical pre-existing 4 (registry-order group)
bun test packages/sandbox                            # 121/34 — same pre-existing groups
bun test packages/agent                              # 147/1 — same pre-existing
pnpm --dir packages/sandbox typecheck                # exit 0
pnpm --dir packages/agent typecheck                  # exit 2 = pre-existing read.ts:58
SPIKE_ENABLE_AGENT=1 pnpm spike                      # 16/16, hello.txt byte-exact
```

**NEW FAILURES: none.** Test classification: adapter/host mechanics = UNIT VERIFIED;
containment/detached/env = INTEGRATION VERIFIED; model streaming + tool execution +
credential boundary = **REAL GATEWAY VERIFIED**; MCP live = NOT TESTED; production
Vercel Backend deployment = NOT TESTED (no deployment in this environment); Windows =
NOT VERIFIED (unchanged from Phase 2B).

## 12. Limitations

1. Session token is env-visible to agent bash during an active call (short-lived,
   low-privilege; permanent fix = per-call provider config in `prepareCall` — small
   upstream change, deliberately deferred to keep this phase non-invasive).
2. No real MCP server exercised; no real Electron window (host is Electron-main-shaped
   plain Node — Electron embeds it directly).
3. Desktop Backend is a local stand-in server, not the actual second Vercel deployment.
4. History threading uses ModelMessage shape (`role/content`); UI-message conversion
   for the renderer's transcript is adapter work for the UI phase.
5. Approval-response round-trip is implemented (`respondToApproval`) but the live model
   happened not to trigger an approval gate in the E2E run (free model + benign write);
   the mechanism is covered by the adapter unit tests + web-client parity, marked
   accordingly.

## 13. Architecture readiness

**Ready for Phase 6.** The two load-bearing walls are proven live: the agent runs
natively on the user's machine, and no production secret is needed (or present) in the
desktop client. Next phase: real OAgent → `apps/desktop/` shell integration (renderer
↔ this host over IPC, `entry-agent.handler`), the per-call provider-config hardening,
and the Desktop Backend route allowlist.
