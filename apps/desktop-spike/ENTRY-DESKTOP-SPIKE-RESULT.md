# Entry Desktop — LocalSandbox Native Runtime Spike Result

**Date:** 2026-10-01 · **Repo:** entry-agents @ HEAD · **Node:** v22.22.2 · **pnpm:** 11.5.1

## Result: **PASS**

16/16 checks passed. Entry's real agent ran natively in a bare Node process, executed its
real write tool through the real LocalSandbox against the real filesystem, with model
traffic through Entry Gateway. **Zero changes to `packages/agent` or `packages/sandbox`.**

## What was proven

1. `connectSandbox({ type: "local", rootDir })` attaches the real LocalSandbox in a plain Node process.
2. LocalSandbox file ops + `exec()` hit the real local filesystem / local shell (verified independently with `node:fs`).
3. `sharedProvider()` resolves the Entry Gateway from `GATEWAY_BASE_URL`/`GATEWAY_API_KEY` env vars — no hardcoded keys.
4. `openAgent.stream({ messages, options })` streams via AI SDK `toUIMessageStream()` — observable start / tool-call / tool-result / finish events.
5. The **write tool executed** (`tool #1: write` in the stream) and `hello.txt` was created **by the agent**, containing exactly `Hello from Entry Desktop` (asserted from the test process, not the sandbox).
6. Failure modes are clean: missing gateway config throws the documented error; invalid rootDir throws (`mkdir EEXIST` on a non-directory); unknown provider throws `UnsupportedSandboxProviderError` (no silent Vercel fallback); a watchdog proves the process cannot hang indefinitely.

## Exact runtime path (actual source names)

```
bare node process (tsx)
  → @open-agents/sandbox connectSandbox()          packages/sandbox/factory.ts
    → registry dispatch on state.type === "local"  packages/sandbox/registry.ts
      → connectLocal() → new LocalSandbox(rootDir) packages/sandbox/local/sandbox.ts
  → openAgent (ToolLoopAgent instance)             packages/agent/open-agent.ts
    .stream({ messages, options: { sandbox: { state, workingDirectory }, model, permissionMode } })
    → sharedProvider(modelId)                      packages/agent/models.ts (gateway env)
      → Entry Gateway  POST /v1/chat/completions   entry-gateway (deployed service)
    → prepareStep injects sandbox into experimental_context
    → model emits tool call "write"
    → writeFileTool execute                        packages/agent/tools/write.ts
      → getSandbox() → connectSandbox(state)       packages/agent/tools/utils.ts
        → LocalSandbox.writeFile → node:fs         packages/sandbox/local/sandbox.ts
          → real file on disk
  → stream.toUIMessageStream() consumed in Node    AI SDK v6
```

## Command to run

```bash
cd entry-agents/apps/desktop-spike
set -a && source .env && set +a     # GATEWAY_BASE_URL / GATEWAY_API_KEY
SPIKE_ENABLE_AGENT=1 pnpm spike
# (without SPIKE_ENABLE_AGENT=1: sandbox-level checks only, no model turn)
```

## Files created / modified

| File | Status |
|---|---|
| `apps/desktop-spike/package.json` | created (new workspace pkg under existing `apps/*` glob) |
| `apps/desktop-spike/tsconfig.json` | created |
| `apps/desktop-spike/src/local-agent-test.ts` | created (the spike) |
| `apps/desktop-spike/.env` | created — **gateway credentials, chmod 600, gitignored, never hardcoded in source** |
| `.gitignore` | modified (one line: `apps/desktop-spike/.env`) |
| `pnpm-lock.yaml` | modified (lockfile entry for the new workspace pkg) |

**No production Entry code changed.** `git diff -- packages apps/web` is empty.

## Existing Entry code reused (unmodified)

- `@open-agents/agent`: `openAgent` (ToolLoopAgent), `sharedProvider`, `defaultModelLabel`, tools/write.ts (+ its sandbox resolution & approval gating)
- `@open-agents/sandbox`: `connectSandbox`, factory, registry, `LocalSandbox` (`connectLocal`), `SandboxState`

## Runtime dependencies verified absent

No Next.js, no React, no HTTP server, no browser APIs, no `@vercel/sandbox` in the spike's
import graph. Required: Node ≥ 22 (workspace wants 24), pnpm, network to the gateway.

## Blockers (known, documented — none block this spike)

1. **LocalSandbox has no path containment (security, desktop blocker).** Baseline measured:
   - `sandbox.writeFile("/abs/path/outside/root")` → **succeeds**, file created outside rootDir.
   - `sandbox.writeFile("../outside")` → **escapes** the root the same way.
   - `resolve()` (`local/sandbox.ts:23`) joins any absolute path without an allowlist check.
   Note: the *agent tools* are safer than the raw sandbox — `resolveWorkspacePath` +
   `realpath` in `tools/path-security.ts` contain tool paths to `workingDirectory`, and
   bash cwd is restricted by `cwd-security.ts`. The uncontained surface is direct
   LocalSandbox use and any tool path that resolves through symlinks. Fix (desktop
   hardening phase): `allowedRoots` option validated in `resolve()` with realpath.
2. **Node engine:** repo declares Node 24; spike ran on 22 without issue (warning only).
3. **Windows untested here:** grep/glob tools shell out to POSIX `grep`/`find`/`stat`;
   LocalSandbox `exec` uses `/bin/sh`-style spawning. Linux/macOS proven; Windows needs
   the WSL/POSIX-tool decision from the blueprint.
4. **Free-tier model quality:** the default free model ignored exact-content instructions
   on one run (wrote "Hello from Codex!"); `mimo-v2.6-flash:free` complied exactly.
   Behavior is model-side, not agent-side; the spike pins the model via `SPIKE_MODEL`.
5. **Minor:** assistant text was 0 chars on the passing run (the model answered with the
   tool call and no prose) — informational, not a failure. And `stopWhen: stepCountIs(1)`
   in `openAgent` means multi-step turns require the host to loop turns (as the web app
   does) — relevant for the desktop host design, not for this spike.

## Security findings summary

- Direct-write escape confirmed in both absolute and relative-traversal forms (above).
- Approval gates (`permissionMode`, dangerous-command patterns, .env patterns) are live in
  the tool layer and host-agnostic — the spike ran `fullAccess` only to run unattended.
- No secrets were printed; the gateway key lives only in the gitignored `.env`.

## Recommendation

**Proceed to Phase 2: LocalSandbox desktop hardening**, in this order:
1. `allowedRoots` containment in `LocalSandbox.resolve()` (+ realpath symlink check, + tests).
2. `execDetached` + `killCommand` implementation (dev-server support) and capability flags.
3. Make `"local"` user-selectable ("This computer") in `registry-types.ts`.
4. Decide Windows story (WSL vs POSIX tool bundling) before Electron work.
