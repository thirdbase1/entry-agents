# Entry Desktop — Phase 6: Real OAgent Electron Shell Integration + Provider Hardening

**Date:** 2026-10-01 · **Result: PASS WITH LIMITATIONS**

Phase 6 moved the Phase-5-proven `EntryAgentHost` into a **real Electron 40 shell** and ran it
**under Xvfb, end-to-end, against the real Entry Gateway** — the actual Electron app, not the
plain-Node harness. The Phase 5 env-var credential hazard was fixed at the source (per-call
`gatewayConfig` through the agent's own `prepareCall` → `sharedProvider({config})` seam), with a
regression test that fails if it ever comes back.

---

## 1. Real Electron integration — YES

| Step | Command | Result |
|---|---|---|
| Launch real Electron | `xvfb-run -a node_modules/electron/dist/electron --no-sandbox electron-dist/entry-electron-main.cjs` | App loads, preload injects `window.entryAgent`, window shown |
| Multi-step agent turn | `ENTRY_E2E_MODE=multistep` | text + tool-call(write) + tool-result + tool-call(read) + tool-result + text + usage + turn-finished |
| Real filesystem proof | `cat /tmp/entry-e2e-project/electron-proof.txt` | `electron shell works` (20 bytes, real disk) |
| Approval round-trip | `ENTRY_E2E_MODE=approval` (bash tool, "ask" mode) | approval-request → renderer → `respondApproval` → tool ran → `approval-proof.txt` written |
| Cancellation | `ENTRY_E2E_MODE=cancel` (Stop during streaming) | `{"type":"stopped"}` returned; stream cut mid-count; no orphan processes |

The renderer drives the real IPC surface; every privileged operation is in main.

```
Renderer (entry-renderer.html)
   ↓ window.entryAgent.*  (preload contextBridge, invoke-only)
Electron Main (entry-electron-main.ts)
   ↓ entry-agent.handler.ts  (entry:* channels)
EntryAgentHost (desktop-host.ts)
   ↓
openAgent()  →  LocalSandbox (contained at the project root)
```

## 2. Gateway credential boundary

```
EntryAgentHost
   ↓ per-call gatewayConfig {baseURL, apiKey=sessionToken}  (host memory only)
Desktop Backend  (separate apps/web deployment; owns GATEWAY_API_KEY)
   ↓ Authorization: Bearer <server-side gateway key>
Entry Gateway → model
```

**Where every secret lives:**

| Secret | Location | NOT in |
|---|---|---|
| `GATEWAY_API_KEY` | Desktop Backend server env only | Electron main env, renderer, preload, packaged resources, Git |
| Desktop session token | Host/handler memory, passed per model call | `process.env`, sandbox env, renderer, project `.env` |
| `POSTGRES_URL` | Backend server env only | desktop bundle |
| `BETTER_AUTH_SECRET` | Backend server env only | desktop bundle |
| OAuth client secrets / Gmail tokens | Backend server only (Composio owns external OAuth) | desktop bundle |

Verified: `git grep` clean (only a pre-existing *comment* mentioning `sk_live_` prefixes in
`apps/web/lib/billing/bachs.ts`); built Electron bundle contains no key; `.env` gitignored.

## 3. Provider hardening (Step 6) — fixed at the source

Phase 5 limitation: the host set `GATEWAY_BASE_URL`/`GATEWAY_API_KEY` in `process.env`, which
`LocalSandbox.exec` spreads into agent-run bash. **Phase 6 removed the env write entirely.**

Implementation (two additive production edits, no behaviour change when unused):
- `packages/agent/open-agent.ts` — `AgentModelSelection` gains optional `gatewayConfig?: GatewayConfig`;
  `prepareCall` forwards it to `sharedProvider(id, { config })` (main + subagent models). Web hosts
  omit it and keep the existing env-var path unchanged.
- `apps/desktop-spike/src/desktop-host.ts` — passes
  `model: { id, gatewayConfig: { baseURL: backend.baseURL, apiKey: backend.sessionToken } }`;
  no `process.env` write anywhere.

**Regression test** (`src/security-regressions.test.ts`): an agent-run bash subprocess cannot see the
session token or gateway key; `process.env` is byte-identical before/after a send even when the
launcher env contains credentials. This test **failed on the pre-fix code** (proving the Phase 5
hazard was real), then passed after the fix.

## 4. IPC surface

**Requests (renderer → main, `invoke`):** `entry:create-session`, `entry:pick-project`,
`entry:send`, `entry:approval`, `entry:stop`, `entry:dispose`.

**Events (main → renderer, `entry:event`):** `turn-started`, `text-delta`, `reasoning-delta`,
`tool-call`, `tool-result`, `tool-error`, `approval-request`, `usage`, `error`, `turn-finished`,
`stopped`. Adapter = the Phase-5 pure `mapChunkToIpcEvents` (Entry `UIMessageChunk` → IPC); the
Entry AI SDK event model is untouched.

## 5. Multi-step loop (Step 5)

`stopWhen: stepCountIs(1)` is constructor-level in `packages/agent/open-agent.ts`, so the host runs
an outer per-step loop appending `stream.response.messages` and continuing while `finishReason ===
"tool-calls"` (mirrors the web host's loop; the web loop is unchanged). Live-proven: one user
message → write → read → final text.

## 6. Persistence (Step 14) — shared DB, no second schema

`src/shared-db.test.ts` (live Postgres, real `apps/web/lib/db` functions):
desktop creates chat + user message with `tool-invocation` parts (local sandbox state) → web reads
byte-identical `parts` jsonb → web appends assistant message → desktop reads it. Ownership chains
`chats.sessionId → sessions.userId` (chats has no `userId` column — Phase 3 finding). Cleanup
cascade-verified to 0 rows. Usage accounting reuses the single Phase-4-proven path (`recordUsage`);
no second calculator.

## 7. Backend route allowlist + model proxy (Steps 7–8)

`src/desktop-backend-proxy.ts` defines the single canonical allowlist (auth/session, `/api/models`,
`/api/usage`, `/api/desktop/v1/*` model proxy) — fails closed; `/api/chat` (web Workflow path),
`/api/admin/*`, `/api/sessions/*/dev-server` are **not** exposed to desktop. The model proxy
authenticates the desktop session, forwards to the Gateway with the server-side key, streams the
response back, propagates aborts, and never returns the key.

## 8. MCP (Step 12) — status

- **Supported:** `createMcpToolSet` (real `@open-agents/agent` export) merged via the host's
  `extraTools` per call; failure-degradation verified (unreachable server → recorded failure, no
  tools, no throw).
- **Not yet tested:** a live MCP server on this machine (`ENTRY_MCP_SERVER_CMD` unset) — the test
  **skips and logs NOT YET TESTED**, never fakes a pass.
- **Blocker:** none architectural; just no server provisioned here.

## 9. Exact test results (Step 16)

| Suite | Command | Result | Baseline |
|---|---|---|---|
| sandbox | `bun test packages/sandbox` | **121 pass / 34 fail** | identical (pre-existing) |
| agent | `bun test packages/agent` | **147 pass / 1 fail** | identical (pre-existing `read.ts` TS2532) |
| desktop-spike (all) | `bun test src/` (with `POSTGRES_URL`) | **28 pass / 0 fail** | host 7/7, e2e 4/4, +security 4/4, +parity 10/10, +shared-db 1/1, +mcp 2/2 |
| sandbox typecheck | `bun x tsc -p packages/sandbox/tsconfig.json --noEmit` | **exit 0** | 0 |
| Electron smoke | (Step 1 table) | **PASS** | new |

No new failures. All pre-existing failures preserved at the same counts.

## 10. Limitations

**Verified:** real Electron launch + preload + IPC; multi-step tool loop; approval
approve/reject path; cancellation with `stopped` event; per-call credential path against the real
Gateway; agent-run bash cannot read host credentials; filesystem containment; allowlist fails
closed; shared-DB round-trip.

**Not verified:** live MCP server; the approval **reject** branch in Electron (the handler routes
`approved:false` identically to the tested `true` path and the unit suite covers the routing, but
the real-renderer reject click was not exercised); Windows/macOS platform behaviours
(logic-reviewed only); the deployed second Vercel project (backend is a local proxy/stub here).

**Blocked:** app-store packaging, installers, auto-update, polished UI — explicitly out of Phase 6
scope by the hard stop.

**Future work:** per-call provider config could also drop the token from shell env for the
*backend's* own call path; live MCP wiring; Vercel Project-B deployment + middleware enforcement of
the allowlist.

## 11. Ready for the next phase?

**Yes.** The renderer ↔ IPC ↔ EntryAgentHost ↔ LocalSandbox ↔ Backend/Gateway boundary is real and
tested end-to-end on the actual Electron runtime, the credential boundary is enforced and
regression-guarded, and shared-DB persistence is proven. Remaining gaps are provisioning/deployment
work (live MCP, real second Vercel deployment) and platform coverage — not architectural unknowns.

## Files changed (Phase 6)

**Production (additive, web behaviour unchanged):**
- `packages/agent/open-agent.ts` — `gatewayConfig` field + `prepareCall` passthrough.

**Desktop spike (new):**
- `src/desktop-host.ts` — per-call `gatewayConfig`, env write removed.
- `src/entry-agent.handler.ts` — `entry:*` IPC handler.
- `src/entry-electron-main.ts` — real Electron main.
- `src/entry-preload.ts` — contextBridge surface.
- `src/desktop-backend-proxy.ts` — allowlist + model proxy.
- `src/security-regressions.test.ts`, `src/shared-db.test.ts`, `src/mcp.test.ts`.
- `electron-dist/entry-renderer.html` — E2E harness page.
