# Entry Desktop Hardening Result

**Phase 2A:** `LocalSandbox` path containment · **Phase 2B:** process lifecycle · **Phase 2C:** local provider discoverability
**Date:** 2026-10-01

---
---

# Phase 2C — Local Provider Discoverability

**Scope:** provider metadata + a runtime-context availability mechanism, inside `packages/sandbox/` only.
**Hard stop respected:** no Electron/OAgent, no desktop settings/IPC/backend, no UI, no plugin system, no web app changes.

## Result: **PASS**

The existing `local` provider is now discoverable as **"This computer"** through the
registry's existing metadata shape, and a desktop host can opt in to it without the
web deployment ever offering it.

## Files changed

- `packages/sandbox/registry-types.ts` — displayName/description for `local` + `CONTEXT_SANDBOX_TYPES`/`listProvidersForContext`/`isSelectableInContext`
- `packages/sandbox/index.ts` — export the three new symbols
- `packages/sandbox/registry-local.test.ts` — NEW (9 tests)

## Registry architecture discovered (Step 1)

- Providers live in `SANDBOX_PROVIDER_METADATA: Record<SandboxProviderId, SandboxProviderMetadata>` with `{id, displayName, description, capabilities}` — **display names already existed**; `local` was present as `"Local"` with description `"Local directory (development only)"`.
- `SANDBOX_TYPES` = every dispatchable id; `USER_SELECTABLE_SANDBOX_TYPES` = `["boat","vercel"]` — **`local` was technically fully supported but deliberately not exposed** (`isKnownSandboxType("local")` true, selection gate false).
- Dispatch: `connectSandbox(state)` → `requireSandboxProvider(state.type)` → `localProvider.connect` → `connectLocal` → `LocalSandbox`. Unknown ids throw `UnsupportedSandboxProviderError` (no fallback). This path already worked — the spike exercises it.
- `localProvider.buildProvisionState` defaults rootDir to `/tmp/entry-sandbox-${sessionId}` — desktop will pass an explicit project rootDir instead; no registry change needed.

## How "This computer" is exposed

Metadata only, no new fields invented:

```diff
   local: {
     id: "local",
-    displayName: "Local",
-    description: "Local directory (development only)",
+    displayName: "This computer",
+    description: "Runs directly on this machine (desktop)",
```

## Web vs desktop availability (Step 4) — the important design decision

`USER_SELECTABLE_SANDBOX_TYPES` is consumed **directly by apps/web**:
`sandbox-selector-compact.tsx`, `settings/preferences-section.tsx`,
`session-chat-context.tsx`, and 3 API validation routes (`api/sandbox`,
`api/settings/preferences`, `api/sessions`). Adding `local` to that array would have
made the Vercel-deployed web app offer "This computer" — meaning the **Vercel server's
filesystem**. Unsafe and misleading, exactly the failure mode Step 4 warns about.

Smallest clean mechanism — a runtime-context map beside the existing arrays:

```ts
export const CONTEXT_SANDBOX_TYPES = {
  web: [],              // shared web selector: remote providers only
  desktop: ["local"],   // desktop host opts in
} as const satisfies Record<string, readonly SandboxProviderId[]>;

listProvidersForContext("web")     // ["boat", "vercel"]
listProvidersForContext("desktop") // ["boat", "vercel", "local"]
isSelectableInContext("local", "web")     // false
isSelectableInContext("local", "desktop") // true
```

Reasoning: unknown context **defaults to web** (most restrictive — fail closed);
web ⊆ desktop; remote providers stay selectable on desktop too; no desktop behavior is
hard-coded into web code, and the eventual Electron selector just calls
`listProvidersForContext("desktop")` — one function, no parallel provider system.
Web app code is untouched and does not need to know this exists.

## Capability metadata

Unchanged from Phase 2B and verified by test: `LOCAL_CAPABILITIES.execDetached === true`,
`killCommand === true`, full set asserted (`persistentResume: true`, no snapshots/ports/
credential brokering/timeout extension, `maxTimeoutMs: null`). Vercel and Boat metadata
asserted byte-identical to before. No fake capabilities, no shared type change required.

## Tests — exact commands and results

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test packages/sandbox/registry-local.test.ts   # 9 pass, 0 fail  (NEW)
bun test packages/sandbox/local packages/sandbox/registry.test.ts \
         packages/sandbox/registry-local.test.ts   # 53 pass, 4 fail (4 = pre-existing, below)
bun test packages/sandbox                          # 121 pass, 34 fail (same 12 pre-existing groups)
pnpm --dir packages/sandbox typecheck              # exit 0
```

**NEW FAILURES: none.** The 4 registry.test.ts failures are identical before/after
(verified via `git stash` round-trip): the registry-order test that still expects
`["vercel","boat"]` order, plus the three Phase-2B-era capability/Vercel-SDK-drift
failures. **PRE-EXISTING FAILURES:** unchanged — Vercel SDK drift (12 groups), Boat
escaping, registry-order/provider-state.

Covered: discoverable metadata · id `local` · displayName `"This computer"` · real
`connectSandbox({type:"local"})` dispatch reaching LocalSandbox (`execDetached`/`killCommand`
present) · capabilities exact · web list unchanged and excludes local · desktop list
includes local plus web providers · unknown id rejected in both contexts · default
context = web · Vercel/Boat metadata untouched.

## Desktop spike

**16/16 PASS** (`SPIKE_ENABLE_AGENT=1 pnpm spike`), hello.txt created byte-exact.
Unchanged — the spike already went through `connectSandbox` → local.

## Limitations

1. `apps/web` still calls `isUserSelectableSandboxType` (web-only, unchanged) — the desktop host must use `isSelectableInContext(..., "desktop")`; that wiring is a later phase.
2. No desktop UI consumes the new context functions yet (intentionally — no UI in this phase).
3. Pre-existing Vercel/Boat SDK-drift failures remain (12 groups, untouched).

## Ready for next phase

Yes. Sandbox abstraction is complete: contained filesystem, owned process lifecycle,
and provider discoverability with correct web/desktop availability semantics. Next
phase (per plan) is the broader Entry codebase + Backend Parity inspection.

---
---

# Phase 2B — LocalSandbox Process Lifecycle

**Scope:** `execDetached` + `killCommand` + capability flags on `LocalSandbox` only.
**Hard stop respected:** no "This computer" provider UI, no Electron/OAgent, no terminal UI,
no PTY, no Windows shell strategy, no OS-level command sandboxing, no plugin system.

## Result: **PASS WITH LIMITATIONS**

`LocalSandbox` can start a background process (dev server), hand control back immediately,
and later terminate exactly the processes it owns. Limitations are Windows process-tree
semantics and output being intentionally discarded — both documented below.

## API added

Exact signatures (unchanged interface — implemented the existing optional methods):

```ts
// packages/sandbox/interface.ts (existing contract, now implemented by LocalSandbox)
execDetached?(command: string, cwd: string): Promise<{ commandId: string }>;
killCommand?(cmdId: string): Promise<void>;

// packages/sandbox/local/sandbox.ts (implementation; no signature inventions)
async execDetached(command: string, cwd: string): Promise<{ commandId: string }>
async killCommand(cmdId: string): Promise<void>
private signalTree(child: ChildProcess, signal: NodeJS.Signals): void
```

No new public types, no new options, no interface change. `commandId` values are opaque
and instance-local: `local-1`, `local-2`, … (monotonic per `LocalSandbox` instance).

## Process ownership

- Each `LocalSandbox` instance owns a `private ownedCommands: Map<string, { child: ChildProcess; label: string }>`.
- `execDetached` inserts; an `'exit'` listener removes the entry — so self-exited
  processes deregister too, not only killed ones.
- `killCommand` looks up the opaque id in that map and acts **only** on the stored
  `ChildProcess` handle. There is no PID lookup path anywhere, so an unknown/foreign/stale
  id (including `"1"` or the test process's own PID) is a no-op that resolves normally.
  A second `LocalSandbox` instance's ids are foreign to the first.
- Verified by test: an unknown id does not kill anything, and a refused cross-instance kill
  leaves the real process running.

## Detached semantics — what `execDetached()` guarantees

- Spawns the command and **returns as soon as the child is spawned** — no completion wait,
  no quick-failure probe (deliberately unlike Vercel's, which races a short window to
  surface early crashes; a local dev server still booting must not be reported as failed).
- `detached: true` → own process group (POSIX) / detached console (Windows).
- `stdio: "ignore"` on all three streams, plus `child.unref()`. Output is **intentionally
  discarded**: no in-memory log buffer exists, so a chatty server cannot grow host memory,
  and the Node host is not held alive by the process. Documented in the method doc — follow
  the server's own log file (or a future UI terminal) for output.
- **cwd goes through the same `resolvePath()` containment as `exec()`** — an
  out-of-workspace cwd throws `LocalSandboxPathError` (verified for `..`, absolute outside,
  and `/etc`).
- Environment: identical to `exec()` — `{ ...process.env, ...this.env }`, inherited as
  before. No logging of the environment; no env management changes.

## Kill semantics — what `killCommand()` guarantees

- Terminates only the process tree stored under that id. SIGTERM to the **process group**
  first (so `pnpm dev`'s wrapper can forward it), escalated to SIGKILL after
  `KILL_ESCALATION_MS` (1 s) if the tree has not exited.
- Unknown/foreign/already-exited id → resolves normally, no throw (matches the interface's
  `Promise<void>` and Entry's convention of treating an already-dead command as gone, not a
  fatal error).
- Entry is removed from the registry immediately, so ids are not reusable.
- **Not** arbitrary PID killing: no API accepts a PID.

## Process tree limitations

- **POSIX (verified here):** the group signal reaches `pnpm → node → server` because the
  child leads its own process group. Verified by the dev-server test (a Node HTTP server in
  a grandchild process is confirmed dead and the port closed after one `killCommand`).
  Residual gap: a process that deliberately re-parents itself into a new group
  (`setsid`, double-fork daemons) escapes the group signal — inherent to this approach, not
  solved here.
- **Windows (not executed, code-reviewed only):** no process groups, so `signalTree` signals
  the direct child only; grandchildren may survive. Escalation SIGTERM→SIGKILL still applies.
  The `win32` branch is isolated in `signalTree` for later work. **Runtime-unverified.**
- No cgroup/job-object style tree containment — deliberately out of scope (that is OS-level
  command sandboxing, a later phase).

## Capabilities

`LOCAL_CAPABILITIES` in `packages/sandbox/registry-types.ts` — reused the existing
capability system, no second one invented:

```diff
- execDetached: false,
- killCommand: false,
+ execDetached: true,
+ killCommand: true,
```

`VERCEL_CAPABILITIES` / `BOAT_CAPABILITIES` unchanged. Metadata `description` string left
untouched (provider-UI wording is a later phase). Per the existing registry contract,
**local now supports background commands and no other provider gained anything.**

## Tests — exact commands and results

```bash
export PATH="$HOME/.bun/bin:$PATH"

# New process-lifecycle tests
bun test packages/sandbox/local/detached.test.ts     # 8 pass, 0 fail

# All LocalSandbox tests (containment + lifecycle + original)
bun test packages/sandbox/local                      # 31 pass, 0 fail

# Full sandbox suite (backward compat)
bun test packages/sandbox                            # 112 pass, 34 fail
#   identical 12 pre-existing failure groups as the Phase 2A baseline
#   (Vercel SDK 'Drive' export mismatch, Boat escaping, registry-order, provider-state)

# Typecheck
pnpm --dir packages/sandbox typecheck                # exit 0
#   (packages/agent typecheck fails on tools/read.ts:58 identically on the clean tree —
#    pre-existing, untouched)

# Desktop spike
SPIKE_ENABLE_AGENT=1 pnpm spike                      # 16/16 PASS, hello.txt created
```

Covered cases: returns immediately with an id · unique ids · alive after return (independent
`kill -0` probe) · kill terminates · already-exited resolves cleanly · unknown/foreign ids
refused (no arbitrary PID kill) · cross-instance ids foreign · cwd containment (inside OK,
`..`/absolute/`/etc` → `LocalSandboxPathError`) · dev-server-style Node server binds a port,
verified listening, killed, port confirmed closed · `stop()` terminates all owned processes.
All cleanup is in `finally`/`afterAll`; no process survives a failing test.

## Desktop spike

**Still 16/16**, `hello.txt` created by the Entry agent (content verified byte-exact).
No regression from the process-lifecycle change.

## Remaining limitations

1. **Windows process-tree termination unverified** (code-reviewed; no groups on Windows, so grandchildren may survive).
2. **Self-detaching daemons** (`setsid`/double-fork) escape the process-group signal.
3. **Detached output is discarded** by design — no per-command log capture yet.
4. Pre-existing Vercel/Boat test failures (SDK drift) remain, unrelated.

## Next recommended task

**Phase 2C:** make `local` a selectable provider — add it to
`USER_SELECTABLE_SANDBOX_TYPES` with an honest display name ("This computer"),
and update the provider metadata description that still says "development only".
No UI work in this repository yet; this is the registry/metadata step the eventual
desktop selector reads.

---
---

# Phase 2A — LocalSandbox Path Containment

**Date:** 2026-10-01 · **Scope:** `LocalSandbox` path containment only.
**Hard stop respected:** no execDetached (added in 2B), no capability-flag changes (2B), no provider-UI changes, no Windows shell work, no Electron/OAgent work.

---

## Result: **PASS** (with documented TOCTOU limitation — see below)

`LocalSandbox` is now a genuine workspace boundary: every path-taking method
(`readFile`, `readFileBuffer`, `writeFile`, `writeFileBuffer`, `stat`, `access`,
`mkdir`, `readdir`, `exec` cwd) resolves through one canonical containment
function, so it is safe even when called directly, bypassing the higher-level
tool guards. All existing Entry behavior (tool layer, providers, registry,
desktop spike) continues to work.

## Files changed

| File | Change |
|---|---|
| `packages/sandbox/local/sandbox.ts` | Containment added: `resolvePath()` (single canonical security path), `LocalSandboxPathError`, `allowedRoots` connect option, canonicalized roots via realpath at construction. All 9 path-accepting methods now route through it. |
| `packages/sandbox/local/containment.test.ts` | **New.** 16 focused containment tests using real symlinks, exercised through the actual LocalSandbox methods. |
| `apps/desktop-spike/src/local-agent-test.ts` | No code change required; its boundary probes now observe the new rejection behavior (previously documented escapes). |

Not touched: `interface.ts`, `factory.ts`, `registry.ts`, `registry-types.ts`,
`vercel/*`, `boat/*` (verified via `git diff --stat` — empty), and the
higher-level tool guards in `packages/agent/tools/`.

## Security behavior

- **Traversal** (`../outside`, `../../outside`, `a/b/c/../../../../outside`): rejected. Paths are normalized before comparison, so segments that leave the root can never pass.
- **Absolute paths outside root**: rejected for read/write/mkdir/readdir/access.
- **Prefix collisions** (`<root>-secret`, including reached via `../project-secret`): rejected. Containment uses `path.relative` + whole-segment comparison, never a string-prefix test.
- **Symlinks**: resolved. The deepest *existing* ancestor is realpath-resolved before comparison, so a symlink whose target is outside the root is rejected even when the link itself sits lexically inside the root — including multi-hop chains (`outer -> chain/inner -> outside`).
- **Symlinked root**: the root itself is canonicalized via realpath at construction, so a sandbox rooted at a symlink matches paths through either name.
- **Nonexistent paths** (`src/brand/new-file.txt`): still writable. Realpath is taken on the deepest existing ancestor; the nonexistent tail is re-appended before the containment comparison. Existing tools' write-creates-parents behavior is unchanged.
- **Root itself**: access/readdir/stat on the root remain valid, matching the existing interface expectations.
- **`exec` cwd**: goes through the same check — including symlinked cwd — so exec cannot be aimed outside the workspace.
- **`allowedRoots`** (new connect option): opt-in extra roots, canonicalized the same way; anything not listed stays rejected. Default remains root-only.
- **Error behavior**: `LocalSandboxPathError` with `code: "LOCAL_SANDBOX_PATH_OUTSIDE_ROOT"`. The message echoes only the caller-provided string; it never contains the resolved host path, realpath, or symlink target (asserted in tests). No env/secret exposure.
- **Higher-level protections preserved**: `tools/path-security.ts` and `tools/cwd-security.ts` are untouched; LocalSandbox containment is an independent second layer beneath them.

### TOCTOU (documented limitation — not race-free)

The check-then-act sequence (`resolvePath` → `fs` operation) is **not**
race-free: a symlink swapped in between containment resolution and the
subsequent operation can still redirect it, and a directory swapped into a
resolved path is not re-verified. True race-freedom requires
descriptor-relative syscalls (`openat` + `O_NOFOLLOW`), which Node does not
expose portably. Practical exposure is limited because every party that can
win that race (same-user local processes) already holds the user's full file
permissions; the boundary's purpose is confining the *model-driven* path
selection, not defending against hostile same-user processes. This limitation
is stated in the `resolvePath` doc comment.

### Windows limitations (inspected, not verifiable here)

Analysis is code-level only; this environment is Linux and no Windows
execution was possible.

- `path.resolve`/`path.isAbsolute`/`path.relative` on win32 handle `C:\...`, `C:/...`, mixed separators, and `\\server\share` UNC paths correctly, and are case-insensitive only if the platform says so (Node uses the host rules) — so drive-absolute and UNC paths flow through the same normalization, and drive-relative inputs (`C:foo`) resolve against the drive cwd like any Node program.
- `fs.realpath` on Windows resolves the path and is case-correcting, which helps the root-canonicalization comparison.
- **Unverified on Windows:** actual behavior with reserved device names (`CON`, `NUL`), case-folding edge cases, long-path prefixes (`\\?\`), and whether `mkdtemp`-based temp roots behave identically. The containment *logic* is portable (no hardcoded `/`), but Windows execution of the test suite remains outstanding.
- Out of scope by instruction: POSIX-only `grep`/`find`/`stat` tool shell-outs and the bash default shell.

## Tests — exact commands and results

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun installed for this environment

# 1. Baseline BEFORE the change
bun test packages/sandbox/local/sandbox.test.ts   # 7 pass, 0 fail
bun test packages/sandbox                          # 88 pass, 34 fail (all pre-existing)

# 2. New containment tests + existing LocalSandbox tests AFTER the change
bun test packages/sandbox/local
# → 23 pass, 0 fail (16 new containment tests + 7 pre-existing)

# 3. Full sandbox suite AFTER (backward compat)
bun test packages/sandbox
# → 104 pass, 34 fail — identical 12 pre-existing failure groups as baseline
#   (Vercel SDK 'Drive' export mismatch, Boat escaping, registry-order,
#   provider-state tests; all fail identically on the clean tree)

# 4. Agent package (tool guards untouched)
bun test packages/agent          # 147 pass, 1 fail (pre-existing model-catalog test, fails on clean tree too)

# 5. Typecheck
pnpm --dir packages/sandbox typecheck   # exit 0

# 6. Desktop spike re-run
SPIKE_ENABLE_AGENT=1 pnpm spike   # 16/16 PASS — hello.txt created by the Entry agent
```

All symlink REJECT cases ran against **real symlinks** created with
`fs.symlink` (verified supported on this platform); nothing is string-simulated.
The suite fails loudly ("SYMLINK UNAVAILABLE: …") rather than silently skipping
if a platform cannot create symlinks.

## Desktop spike

**Still passes: 16/16**, including `hello.txt` created through the real agent
turn (`tool #1: write` → content verified byte-exact). The spike's former
boundary probes now receive `LocalSandboxPathError` instead of succeeding —
the earlier documented escape is closed.

## Remaining risks (real ones only)

1. **TOCTOU races** as documented above — inherent to the Node API surface; accepted for same-user desktop use.
2. **`exec` commands are not path-contained** — `bash -c "cat /etc/passwd"` runs with full user privileges; the boundary confines *paths the sandbox API is given*, not what a shell command may touch. Containing arbitrary commands needs OS-level sandboxing (separate future task, e.g. seatbelt/bubblewrap) — deliberately not attempted here.
3. **Windows unverified at runtime** (see above).
4. Pre-existing test failures in Vercel/Boat suites (SDK drift) — unrelated to this change, flagged for separate maintenance.

## Next recommended task

**Phase 2B: `execDetached` + `killCommand` for LocalSandbox** (dev-server
support, ~40 lines, capability flags updated) — per the migration plan, before
any "This computer" provider UI or Electron work. The Windows runtime
verification can proceed in parallel as a documentation/test-infrastructure
task.
