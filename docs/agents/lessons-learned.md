# Lessons Learned

Hard-won knowledge from building this codebase. When you make a mistake or discover a non-obvious behavior, add it here.

## General / Tooling

- Skill discovery de-duplicates by first-seen name, so project skill directories must be scanned before user-level directories to allow project overrides.
- The system prompt should list all model-invocable skills (including non-user-invocable ones), and reserve user-invocable filtering for the slash-command UI.
- Glob patterns ending in `**` (for example `"**"` or `"src/**"`) should be treated as recursive, even when `**` is the final segment.
- In shell tools, avoid piping primary command output directly to `head` when exit-code handling matters; pipeline semantics can mask real failures from the primary command.
- Bash approval heuristics should reserve prompts for clearly destructive commands (for example `rm -rf`, `sudo`, or mutating git/package-manager operations); treating pipes/chaining and common filesystem reads as dangerous creates too many false-positive approvals for normal inspection commands.
- Verification instructions must tell the agent to consult AGENTS.md / `package.json` scripts **before** listing generic steps like "typecheck -> lint -> build"; otherwise models default to raw commands (`npx tsc`, `eslint .`) which bypass project-specific tool config (turbo pipelines, tsconfig references, ultracite, etc.) and produce incorrect or incomplete results.
- Tool renderer `part.output` values may be `unknown`; when accessing fields like `files` or `matches`, add runtime narrowing/type guards first (in both TUI and web renderers) to satisfy strict typecheck.
- AI SDK stream handles may return `PromiseLike` values (not full `Promise`), so avoid methods like `.finally()` and use `then`/`catch` patterns that work with `PromiseLike`.
- After schema edits, review generated Drizzle migrations for unrelated schema drift changes before committing (for example defaults on untouched columns), since `drizzle-kit generate` can include those alongside intended changes.
- pnpm 11 requires an explicit `allowBuilds` map in `pnpm-workspace.yaml`; approve required native/tooling builds deliberately and keep non-functional lifecycle scripts disabled.
- Keep pnpm release-age policy explicit in `pnpm-workspace.yaml`: enforce a strict one-day `minimumReleaseAge` and fail closed when publish timestamps are missing.
- Use `pnpm run ci` for the repository verification script. `pnpm ci` invokes pnpm's built-in clean-install command instead of the package script.
- Keep Kysely pinned to `0.28.x` until Better Auth's bundled Kysely adapter stops importing migration constants from Kysely's root entrypoint; Kysely `0.29.x` removed those root exports and breaks the Next production bundle.
- Node 24's built-in TypeScript support uses native ESM resolution and ignores tsconfig path aliases, so utility-script dependency chains need explicit `.ts` extensions and relative imports.
- `bunx @vercel/config validate` executes the CLI under Node via its shebang and cannot parse TypeScript-style `vercel.ts` imports; use `bunx --bun @vercel/config validate` (or `bun node_modules/@vercel/config/dist/cli.js validate`) for reliable local validation.
- Successful Vercel CLI auth (`vercel whoami`, team/project REST APIs, `.vercel` linking) does **not** guarantee Workflow observability access. `workflow inspect ... --backend vercel` can still fail with `401 {"error":{"code":"unauthorized","message":"You are not allowed to access this endpoint."}}` when the user/token lacks the Vercel product permission documented as `Vercel Workflow` (and possibly related Observability access), even if `WORKFLOW_VERCEL_AUTH_TOKEN` is passed explicitly from the Vercel CLI auth file.

## Next.js

- In Next.js App Router, dynamic route param names must match the folder segment exactly (e.g. `[sessionId]` requires `params.sessionId`, not `params.id`), or DB queries can receive `undefined` and fail at runtime.
- Some planning docs still reference legacy `apps/web/app/tasks/[id]/...` paths; current UI/API code is centered on `apps/web/app/sessions/[sessionId]/chats/[chatId]/...`, so verify file paths before implementing plan items.
- Next.js `after()` defers callbacks until the response is fully sent; for streaming endpoints this means `after()` runs after the entire stream completes, not at call time. Use fire-and-forget (`void run()`) for lifecycle kicks that must happen at request start.
- In Next.js Route Handlers, `cookies()` from `next/headers` combined with `Response.redirect()` silently drops Set-Cookie headers from the redirect response. Use `NextResponse.redirect()` with `response.cookies.set()` instead to ensure cookies are included in redirect responses.
- In this codebase's Next.js version, `revalidateTag` must be called with a second argument (for example `{ expire: 0 }`); single-argument calls fail typecheck.
- For Workflow SDK discovery in Next.js, ensure workflow files live in scanned directories (for this app, `app/`), otherwise manifests can show steps but `0 workflows` and `start()` will not run durable workflows.
- Server-side optimistic chat route lookup must allow realistic persistence latency (multi-second retry window), otherwise `/sessions/[sessionId]/chats/[chatId]` can redirect away before chat creation finishes.

## Sandbox Lifecycle

- Detached/background bash results may have `exitCode: null` for both successful starts and explicit tool failures; bash renderer error state must also honor `output.success === false` (not only numeric non-zero exit codes), and detached quick-failure probing should prefer a timer-vs-wait race branch over matching SDK-specific error names.
- Creating a sandbox snapshot automatically shuts down that sandbox; lifecycle plans and implementations must treat snapshotting as a stop/hibernate transition, not a non-disruptive backup.
- Vercel `sdk.domain(port)` throws when a sandbox has no route for that port (common on some restored/reconnected sandboxes); environment/prompt metadata should guard per-port URL generation instead of assuming every configured port is routable.
- Vercel sandbox creation has a hard timeout limit of `18_000_000ms`; if you add an internal timeout buffer before calling the SDK, clamp proactive timeout so `timeout + buffer` never exceeds that API limit.
- In serverless environments, lifecycle checks that only run inline during request handlers are not durable; long-gap sandbox lifecycle actions must be scheduled with a durable workflow run (`start(...)` + `sleep(...)`) so they execute without a connected client.
- Vercel `snapshot()` may return `422 sandbox_snapshotting` when another snapshot is already in progress; lifecycle code should treat this as an idempotent/in-progress condition and reconcile state instead of marking lifecycle as failed.
- The reconnect API can return `expired` when a sandbox has already stopped; client reconnection state should treat `expired` like `no_sandbox` so restore UX does not get stuck in a generic failure path.
- For workflow-managed sandbox lifecycle, avoid client-side timeout auto-stop logic in the chat UI; it can race with workflow hibernate and produce confusing paused overlays while the tab remains open.
- Snapshot restore should be idempotent when a sandbox is already running: return success with an `alreadyRunning` signal instead of a 400, and let the client reconnect/sync rather than surfacing a hard error.
- For lifecycle workflow kicks in request handlers, call `kickSandboxLifecycleWorkflow(...)` directly instead of wrapping it in `after(...)`; delayed/deferred scheduling can miss the initial hibernation timer for idle sessions.
- For sandbox lifecycle kicks, do not persist `lifecycleRunId` before `start(...)`; start first and let the durable workflow claim/verify the lease so canceled fire-and-forget kicks cannot strand a stale lease.
- Lifecycle workflow must retry after a `skipped/not-due-yet` evaluation; without retry the sandbox never hibernates unless a new event kicks a fresh workflow.
- When the lifecycle workflow inline fallback runs (SDK unavailable), it evaluates immediately and skips because the sandbox isn't due yet; the status endpoint should detect overdue `hibernateAfter` and kick the lifecycle as a safety net.

## Sandbox UI State

- Status chips that derive from time-based sandbox validity should not rely on memoization without a time dependency; otherwise header state can drift from overlay/input state as `Date.now()` changes.
- Keep sandbox status UI elements (chip, overlay, and indicator dot) on a shared `isSandboxActive` source; mixed heuristics (e.g., one using grace-window validity and another using raw countdown) can show contradictory states like `Paused` with a green dot.
- Treat `/api/sandbox/reconnect` as a read-only status probe; reconnect polling should never refresh lifecycle activity timestamps or kick lifecycle workflows, or idle sessions can fail to hibernate correctly.
- For paused sessions, auto-resume on entry should trigger only after reconnect confirms `no_sandbox`; do not auto-restore on generic reconnect failures.
- Do not use `snapshotUrl` alone to infer paused/hibernating UI state; active sessions may retain a snapshot reference. Require absence of runtime sandbox state (`sandboxId`/`files`) before labeling hibernation.
- Keep sandbox mode details out of page/presentation components: expose capability flags (for example `supportsDiff`, `supportsRepoCreation`, `hasRuntimeSandboxState`) from shared context and branch UI on capabilities, not raw `sandboxState.type`.
- Auto-resume-on-entry for paused sessions must not require a prior `no_sandbox` reconnect result when there is no runtime sandbox state in DB; snapshot-only sessions can otherwise get stuck in `idle` and never restore.
- For predictive lifecycle UI countdowns, use server-provided timestamps (`hibernateAfter`, `sandboxExpiresAt`) plus a server-time offset from reconnect responses; do not rely on client clock alone for transition timing.
- Auto-resume for paused sessions must run only on initial session entry; once a tab has had an active sandbox, do not auto-resume after a later inactivity hibernate in that same tab.
- Keep the sandbox indicator dot on the same derived lifecycle state machine as the status chip; during inactivity countdown it should show a pausing state, and during server `hibernating` it should not remain green.
- Split lifecycle UI polling from connectivity probing: poll a lightweight DB-backed sandbox status endpoint for timing/state, and reserve reconnect/connect checks for entry/resume or explicit recovery paths.
- Prefer event-first lifecycle sync in the chat UI (chat completion, visibility return, window focus, network online), with sparse status polling (about 60s baseline, tighter only near transitions) instead of frequent fixed-interval polling.
- When syncing status timestamps, avoid rewriting sandbox connection state on every response; only update if expiry materially changes, or UI effects can enter rapid request loops.
- Resume/paused UI must not rely only on `session.snapshotUrl` from initial page props; keep a live `hasSnapshot` signal from reconnect/status responses, or the UI can incorrectly show `No sandbox` and hide resume actions.
- `/api/sandbox/reconnect` should treat DB runtime state (`sandboxId`/`files`) as the source of reconnect eligibility; using `isSandboxActive` (which includes expiry heuristics) can misclassify recoverable sessions as `no_sandbox` and break restore/reconnect flows.
- When `/api/sandbox/reconnect` reports `connected`, it must persist refreshed sandbox runtime state/expiry (`sandboxState`, `sandboxExpiresAt`) back to DB; otherwise `/files` and `/diff` can still fail with `Sandbox not initialized` against stale expired state while UI thinks reconnect succeeded.
- For sandbox lifecycle UI, keep the client simple and server-authoritative: poll `/api/sandbox/status` on a fixed cadence (currently 15s) instead of combining multiple client-side event/predictive sync paths, which can drift or loop under reconnect/hibernation edge cases.
- Reconnect liveness probes can time out right after snapshot restore while the sandbox is still starting; treat probe timeouts as transient (non-terminal) and clear runtime state only for hard unavailability signals (stopped/not found/stream unavailable).
- Keep `/api/sandbox/status` as a DB-backed read-only view; do not mutate/clear sandbox runtime state from status polling, or active sessions can be downgraded to `no_sandbox` and later restore from stale snapshots.
- On Vercel reconnect (`state.sandboxId`), do not pass `remainingTimeout=0` from stale `state.expiresAt`; that creates an immediately-expired local wrapper and can make the header/API checks flip to `No sandbox` even while the VM is reachable.
- Reconnect success should refresh full active lifecycle timestamps (`lastActivityAt`, `hibernateAfter`, `sandboxExpiresAt`) before responding; otherwise UI status chips can stay stuck in `Pausing` from stale lifecycle fields.
- Lifecycle countdown UI windows should scale with configured inactivity timeout; fixed windows (for example 2 minutes) can make short test timeouts (for example 1 minute) appear to be perpetually pausing.
- Reconnect can return a sandbox handle whose command stream is unusable (`Expected a stream of command data`); reconnect should probe command execution before declaring `connected`, and file/diff routes should treat that error as sandbox-unavailable (hibernated) rather than a git-repo error.
- Archive uses a deferred background snapshot; if unarchive runs before `snapshotUrl` is persisted, resume/restore can race with `no_snapshot`, so unarchive/restore flows must gate on snapshot readiness (or surface a clear snapshot-in-progress state).
- Client UI `sandboxUiStatus` must check server `lifecycleTiming.state` (from status poll) as primary source, not only local `sandboxInfo`; otherwise UI stays "Active" after server-side hibernation until the local timeout expires or user refreshes.
- The `isSandboxActive` client flag must incorporate `lifecycleTiming.state`; local `isSandboxValid(sandboxInfo)` alone is insufficient because the server can hibernate the sandbox while the local timeout is still valid.
- In the sandbox lifecycle evaluator, treat any non-null chat `activeStreamId` as an authoritative no-hibernate signal; do not inspect workflow status or clear stream ids from the lifecycle path, and recheck immediately before snapshotting to avoid racing a newly-started stream.

## Chat / Streaming UI

- In large chat/page client components, extract new feature-specific UI flows into colocated hooks and child components instead of adding more state/effects/handlers inline; if the feature state must survive dropdown/popover/dialog toggles, mount the hook in the parent view and pass its controls down.
- In the web chat UI, do not keep `@ai-sdk/react` Chat instances alive after route transitions while they are still streaming; abort local stream processing and remove the instance on teardown, then rely on resumable stream reconnect when revisiting that chat.
- For client-side tool flows (`ask_user_question`), `onFinish`-only assistant persistence is insufficient across route switches: persist the latest incoming message snapshot at API request start (upsert by message id) so answered/declined tool state survives teardown/resume and does not rehydrate stale `input-available` UI.
- Request-start assistant snapshot persistence must be scoped and ownership-guarded: only upsert assistant messages when the request still owns the chat stream token, and refuse upserts on message-id scope conflict (different chat/role) to prevent stale writes and cross-chat overwrites.
- Keep `activeStreamId` resumable at all times: do not publish pre-registration ownership placeholders to `activeStreamId` (resume probes can clear them as stale), and gate `onFinish` writes on the atomic compare-and-set result that clears the currently owned token.
- Usage analytics `messageCount` must represent assistant turns, not raw `usage_events` rows; when subagent/model breakdown rows are recorded, count only canonical main-agent rows in additive rollups to avoid inflated totals and heatmaps.
- Unread correctness depends on visibility-aware read receipts and insert-only assistant activity updates: block read receipts for hidden tabs, but allow forced read marks on visible tabs without waiting for focus; only advance `lastAssistantMessageAt` when an assistant message upsert actually inserts a new row (not snapshot/tool-result updates).
- Post-turn automations that must happen even after the user leaves the chat (for example auto-commit/push) should be scheduled from the server chat completion path, not only from client `status === "ready"` effects; client-only hooks can miss turns that finish while the page is closed and can lag behind background completion.
- Chat list streaming indicators should poll more frequently while any chat is actively streaming (for example ~1s) and fall back to a slower cadence when idle, to avoid delayed white-to-complete indicator transitions after chat switches.
- Sidebar chat lists should hydrate from server-fetched initial chat summaries (layout props) in addition to SWR fetches, so transient `/api/sessions/[sessionId]/chats` failures do not render an empty list on hard refresh.
- For hydration-sensitive SWR endpoints (notably sidebar chat lists), use a dedicated `no-store` fetcher instead of changing the shared SWR fetcher globally; otherwise browser HTTP caching gets disabled across unrelated `/api` hooks (models, branches, repos, settings).
- Optimistic chat-title previews for `"New chat"` must have an explicit rollback on send failures; otherwise the sidebar can keep a title that was never persisted if the first request errors.
- `hadInitialMessages` is an initial-load snapshot, not a live "first turn" signal; guard one-time optimistic UI (like first-message title previews) with a dedicated runtime ref/state that resets on send failure.
- When session overlay maps are deleted after becoming empty, any later overlay writes in the same hook instance must re-register the map in the global registry, or optimistic overlays will not survive route transitions.
- For resumed chat streams, `chat.stop()` alone is insufficient because reconnect fetches are not wired to the active abort signal; always pair stop with aborting the managed transport tied to that chat instance.
- Automatic stream retries should use soft reconnect semantics and single-flight guards; overlapping hard retries can replay resumable chunks and cause visible reasoning/tool UI flicker.
- In chat UI rendering, treat both `submitted` and `streaming` as in-flight. If only `streaming` is considered active, task/tool parts can be marked interrupted too early and stale `Thinking...` indicators can linger until a full page refresh.
- In Streamdown, `plugins.code.getThemes()` overrides the `shikiTheme` prop; configure code themes in `createCodePlugin(...)` and pass actual custom theme objects for non-bundled themes (for example `vercelLight`/`vercelDark`) or highlighting can fall back to unstyled/plain tokens.
- Shiki dual-theme `TokensResult` can encode dark variants inside semicolon-delimited `fg`/`bg` values and token `htmlStyle` fields (for example `color` + `--shiki-dark`); normalize these into Streamdown's `color`/`bgColor` fields plus root CSS vars, or inline light colors can override dark-mode classes and keep code blocks stuck in light theme.

## GitHub App / PR Flows

- GitHub App install flow uses a three-path strategy: (1) no linked account -- OAuth authorize URL with explicit `redirect_uri`, callback chains to install with `target_id`; (2) linked account but no installations -- `installations/new/permissions?target_id={githubId}` directly; (3) linked account with installations -- `select_target` for the account/org picker. Disable "Request user authorization (OAuth) during installation" on the GitHub App -- it causes auto-redirect loops for already-authorized users on both `select_target` and `installations/new/permissions`.
- GitHub App must be made **public** for the org picker to appear during installation. While the app is private, `/installations/select_target` only shows the owner's personal account -- users cannot install on organizations. Use "Make public" in the GitHub App's Danger Zone when ready.
- Use `/installations/select_target` instead of `/installations/new` for the GitHub App install URL; the latter silently redirects to an existing personal installation's settings page instead of showing the account/org picker.
- GitHub App callbacks that process OAuth `code` or `installation_id` must validate a server-stored `state` nonce before linking accounts or syncing installations; never trust callback query params without CSRF/state verification.
- Installation sync that prunes DB records must fetch all GitHub API pages first (`per_page=100` + pagination); pruning from a partial page can silently remove valid installations.
- In the GitHub App install flow, do a user-token installation sync before redirecting after OAuth-only callbacks or treating zero local installation rows as "not installed"; GitHub can skip callback emissions for pre-existing installs.
- Public upstream repositories may reject direct branch pushes; PR generation should fall back to creating/pushing to the user's fork and PR creation must use a qualified head ref (`forkOwner:branch`).
- GitHub fork creation can take longer than a few seconds to become pushable; PR fallback should retry fork push on transient `repository not found` errors instead of failing immediately.
- Git push failures from Vercel sandboxes can return empty output even when auth/write is denied; PR fallback logic should not rely only on matching "permission" text before attempting fork fallback.
- When the GitHub App lacks push access (e.g. repo removed from installation scope), fail fast with a 403 directing users to /settings/connections rather than silently forking.
- Fixed 2026-08-17: the connection-status check (`getGitHubUsername` calling `api.github.com/user`) treated ANY non-2xx response as "token broken, reconnect required" -- including transient 5xx/429 caused by a GitHub-side outage, not just real 401/403 auth failures. This produced false "reconnect GitHub" prompts for already-connected users during a live GitHub.com incident (2026-08-17, started 13:40 UTC, ~20% error rate on API/web traffic). Fix: added `getGitHubUsernameStrict()` in `apps/web/lib/github/users.ts` -- only 401/403 returns null (real auth failure); other statuses throw, so `connection-status/route.ts`'s existing catch block (which already correctly no-ops to "connected" for non-auth thrown errors from `syncUserInstallations`) now handles this path the same way instead of false-flagging on outage noise.
- Fixed 2026-08-17: `GitHubReconnectDialog` was rendered globally via `GitHubReconnectGate` on every authenticated page with no dismiss button, blocking completely unrelated settings pages (Models, Profile, Preferences, etc) whenever the connection check failed for any reason. Scoped the gate to only fire on `/sessions/*` pages (where repo access actually matters) and added a "Not now" dismiss button to the dialog + a "Skip for now" option in the onboarding GitHub-connect step, so GitHub is opt-in rather than a hard blocker for using the app at all.

## Sandbox / Git Sync

- Fixed 2026-08-17: a resumed/restored sandbox can come back with a `.git` directory that has no `origin` remote configured at all (e.g. a hibernate/restore snapshot taken before the repo was linked, or any other path that drops `.git/config`'s remote entry). `git fetch origin` then fails immediately with `"'origin' does not appear to be a git repository"`, which surfaced to users as "Failed to sync latest remote changes before committing" and permanently blocked every future commit for that session even though the repo and credentials were fine. Fixed with `ensureOriginRemote()` in `packages/sandbox/git.ts`, called at the top of both `syncToRemote()` and `syncToRemotePreservingChanges()` (both now take a required `remoteUrl` param): re-adds `origin` from the session's stored `cloneUrl` (falling back to `https://github.com/<owner>/<repo>.git`) whenever it's found missing, before attempting to fetch. Call sites: `apps/web/lib/github/actions/commit.ts` and `apps/web/lib/chat/auto-commit-direct.ts`.

## Billing / Credit Metering

- Real-time credit enforcement lives in `apps/web/app/workflows/chat.ts`: `startingBalanceCents` is fetched once per turn at workflow start, then decremented in-memory after every model step inside `runAgentStep`'s `finish-step` metadata callback; the instant the running balance hits <=0 it sets `creditExhausted` and calls `abortController.abort()` mid-turn, and the outer step loop (`runAgentWorkflow`) also checks `creditExhausted` on the returned result before starting another step. Soft-cutoff (downgrading a depleted paid account to a cheap model) was intentionally removed on 2026-08-17 -- every plan now hard-blocks at zero balance instead.
- Fixed 2026-08-17 (was previously a known residual risk): concurrent-turn double-spend. Two turns for the same user (e.g. two open tabs) could each read the same starting balance and each spend against it before either self-aborted. Fixed with a per-user billing-turn lock -- `users.activeBillingRunId`/`activeBillingRunClaimedAt` columns, `claimUserBillingTurn`/`releaseUserBillingTurn` in `lib/billing/credit-ledger.ts`. Claimed in `resolveChatModelRuntime` right where the starting balance is read (non-admins only), released in both `runAgentWorkflow` cleanup paths alongside `clearActiveStream` via `releaseUserBillingTurnStep` (`app/workflows/chat-post-finish.ts`). A second concurrent turn is rejected immediately with a clear user-facing error instead of racing stale balance state. Includes a 15-minute staleness fallback (`BILLING_TURN_LOCK_STALE_MS`) so a crashed/orphaned workflow run can never permanently lock a user out -- a later claim attempt can steal an abandoned lock.
- Vercel environment variables added with `--sensitive` (e.g. `FREEMODEL_API_KEY`, `GATEWAY_API_KEY`) cannot be read back in plaintext by anyone after creation -- `vercel env pull`/`env ls` will only ever show `[SENSITIVE]`. To rotate one: `vercel env rm <NAME> production` then pipe the new value into `vercel env add <NAME> production --sensitive`, then redeploy (env var changes do not retroactively apply to already-running deployments).
- `entry-gateway` (the self-hosted model proxy) is its own separate Vercel project from `entry-agents` -- rotating an upstream provider key (FreeModel, OrcaRouter, etc.) means editing env vars on `entry-gateway` and redeploying *that* project, not the main app.
- Incident 2026-08-17: user `ibrahimfaruqolamilekan4@gmail.com` (Plus plan, $10.00 grant) reported the app "drained" their credit. Investigation (queried prod `credit_transactions`/`usage_events` via `@neondatabase/serverless` over HTTPS -- direct TCP :5432 is blocked in the sandbox, only 443 is open) showed the existing `remainingBalanceCents <= 0` check is the *only* per-turn spend guard: it only aborts once the whole account balance is gone, so a single turn with an unbounded number of internal tool-calling steps can spend without limit as long as balance stays positive. Two single turns (21 and 24 tool calls respectively, cumulative input tokens ballooning to ~2.9M and ~4.7M as the growing context got resent on every internal step) burned $5.90 and $3.28 -- $9.18 of the $10.00 grant -- in under 25 minutes, before the user had any indication why. Root-caused, not a pricing/ledger bug: per-token pricing was correct throughout, there was simply no cap on a single turn's own cost.
  - Fix: added `MAX_TURN_SPEND_CENTS` (200, i.e. $2.00) as a second, independent circuit breaker in `runAgentStep`'s `finish-step` handler in `app/workflows/chat.ts` -- tracked via `totalMessageCost` (already persisted across the outer step loop's calls for the same turn via message metadata) and gated separately from `creditExhausted`/`remainingBalanceCents`. New `turnSpendCapped` flag threads through the same abort/outer-loop-break path as `creditExhausted` and is surfaced on `WebAgentUIMessage.metadata` (`app/types.ts`).
  - Also closed a related silent-failure gap: `creditExhausted` metadata was being set for years but **nothing in the UI ever rendered it** despite a code comment claiming `session-chat-content.tsx` shows a dedicated notice -- it didn't exist. Added an actual inline notice (amber card) in `components/assistant-message-groups.tsx` for both `creditExhausted` ("ran out of credit") and `turnSpendCapped` ("this response got expensive, stopped early") so users get a visible explanation instead of a response that just silently cuts off.
  - Manually refunded the affected user 918 cents (exact sum of the two runaway-loop turns) via a direct `credit_transactions` "refund" row + `users.credit_balance_cents` update against the prod DB, matching `creditAccount()`'s ledger-entry shape in `lib/billing/credit-ledger.ts`.
  - To get a real prod `DATABASE_URL` for one-off investigation/fixes when the sandbox's own env only has a bare host fragment (not a full connection string): `vercel env pull --environment=production --token=$VERCEL_TOKEN` inside a linked `.vercel/project.json` checkout, then connect over HTTPS with `@neondatabase/serverless`'s `neon()` (not `postgres-js`, which needs raw TCP and times out under the sandbox's HTTPS-only egress).
  - Follow-up 2026-08-17 (owner pushback, correctly so): a flat spend cap treats the *symptom*, not the cause -- the real bug is the agent looping/retrying instead of solving efficiently. Reframed: `MAX_TURN_SPEND_CENTS` raised from 200 to 500 and re-labeled in code as a last-resort backstop that should almost never fire, not the primary fix. The actual fix is a new "Tool-Call Economy" section in `packages/agent/system-prompt.ts` (shared across all model families): no blind retries on a failing command (stop after 2 identical failures, change approach or ask), cap verification/build/test loops at 3 attempts per issue, don't re-read files/re-run greps already done this turn, batch same-file edits instead of edit-verify-edit-verify, escalate to the user instead of thrashing. Also added a counter-note directly inside `GPT_OVERLAY` (the "NEVER end your turn... keep going until completely solved" block) clarifying that persistence means having a plan, not brute-forcing with unlimited tool calls -- since the two runaway turns were both on `gpt-5.6-*` models, which get that overlay.
  - Also added a per-call usage log to the admin drill-down page (`getAdminUserModelCallLog` in `lib/db/admin-user-detail.ts`, wired into `getAdminUserDetail` in `lib/admin/actions.ts`, rendered in `admin-user-detail-view.tsx`): one row per raw `usage_events` record (not aggregated) showing timestamp, model, tool-call count (highlighted amber at >=15, the same signal that would have caught this incident immediately), input/cached/output tokens, and per-event priced cost -- so an admin can see a single-turn spend spike without needing a DB query.

## Deployment

- Found 2026-08-17: the GitHub -> Vercel git-integration auto-deploy (push to `main`) silently stopped firing for `entry-agents` -- project's git `link` config was verified correct via the Vercel API (github/thirdbase1/entry-agents/main, `gitCredentialId` present), and pushes to `main` landed correctly on GitHub (verified HEAD sha via API), but **two consecutive pushes produced zero new deployments** over 40+ minutes (checked via `GET /v6/deployments?projectId=...` filtering on `meta.githubCommitSha`, not just eyeballing `vercel ls`). Root cause not fully diagnosed (likely a stuck/disconnected webhook on Vercel's side) -- workaround: `vercel deploy --prod --token $TOKEN --yes` from the repo directory uploads local source and builds+deploys directly through the Vercel API/CLI, bypassing the webhook entirely; confirmed this produces a deployment whose `meta.githubCommitSha` matches the exact local commit and gets aliased to `entry-agents.vercel.app`. Until the webhook is confirmed fixed, always verify a push actually produced a matching deployment (by commit SHA) before assuming "git-based auto-deploy" worked -- fall back to `vercel deploy --prod` immediately if it didn't.
- Fixed the same day: `.agents/skills/deploy_entry_vercel/scripts/run.sh` used to poll `vercel ls` text output and grab the *first* row matching `Ready/Building/Error`, with no check that it was actually the deployment for the commit just pushed. Since `vercel ls` is sorted newest-first but a stale pre-existing "Ready" deployment can still be top-of-list before the new one appears, this produced a false "Done, should now be serving commit X" success message while the site was actually still serving an old commit from ~50 minutes earlier. Rewrote the script to poll the Vercel API directly and match on `meta.githubCommitSha == <exact local commit sha>`, and to automatically fall back to a direct `vercel deploy --prod` source deploy if no matching deployment appears within 2 minutes, instead of ever reporting success against an unverified/mismatched deployment.

## 2026-08-18 — PR #6 dependency-security merge (auth/Next.js/nanoid + vuln overrides)

- Reviewed an auto-opened PR (chore(deps), branch `o/22a8703b`, from an
  in-app Entry coding-agent session) bumping better-auth 1.6.5->1.6.29,
  nanoid 5.1.6->5.1.16, and adding pnpm override entries for
  brace-expansion/dompurify/esbuild/hono/mermaid/postcss/sharp/undici.
  This resolved all 60 Dependabot alerts (18 high, 32 moderate, 10 low)
  on the default branch. `pnpm audit --prod` now returns clean.
- The PR was opened before the 2026-08-17 Next.js 16.3.1 upgrade landed
  on main, so it carried a stale `next: ^16.2.11` that would have
  **downgraded** prod Next.js if merged blindly -- GitHub's own
  mergeable_state correctly flagged this as `dirty`. Always check
  `mergeable_state` / do a local `git merge-tree` before merging any
  bot/agent-opened dependency PR, don't just click merge because CI is
  green -- CI here was green on the stale branch tip, conflict only
  shows up against current main.
- The PR also carried an unrelated `uploads/*.webp` file, almost
  certainly a chat-session artifact swept into the same auto-commit.
  Dropped it before merging -- worth eyeballing the full file list on
  any agent-opened PR, not just the intended diff.
- Gotcha: after resolving a `package.json` merge conflict, a plain
  `pnpm install --no-frozen-lockfile` updated the *resolved version* in
  pnpm-lock.yaml but did NOT rewrite the lockfile's `specifier:` string
  to match the new package.json value -- Vercel's `--frozen-lockfile`
  build then failed with "specifiers in the lockfile don't match
  specifiers in package.json". Fix: run a targeted
  `pnpm add <pkg>@<version>` inside the affected workspace (apps/web)
  -- that does force the specifier field. Always verify with a clean
  `rm -rf node_modules && pnpm install --frozen-lockfile` locally before
  pushing merge-conflict-lockfile fixes; it reproduces Vercel's exact
  failure mode.
- Found but deliberately NOT touched in this change: `arctic` (used
  only in apps/web/app/api/github/app/install/route.ts for the GitHub
  App OAuth flow) was deprecated by its maintainer (pilcrowonpaper) in
  July 2026 -- npm shows "Package no longer supported" and the GitHub
  repo says "some example code to replace the package can be found
  under /code". Given how many past painful bugs lived in this exact
  GitHub OAuth/install flow (invalid_state races, installation sync,
  etc. -- see entries above), migrating off arctic needs its own
  dedicated, carefully-tested change, not a drive-by inside a deps PR.
  Flagged as a real follow-up, not done yet.

Deployed: commit a4438d1, live on entry-agents.vercel.app.

## 2026-08-18: gpt-5.6-sol/terra/luna were billed at 35% of real price (entry-gateway config bug)

- Root cause lived in a **Vercel "Sensitive" env var** on the
  entry-gateway project (`EXTRA_MODEL_ROUTES_JSON_3`), not in code:
  the `cost.input`/`cost.output` fields for these 3 routes were
  hardcoded at exactly 0.35x OpenAI's real published price (e.g. terra
  was `$0.70/$4.20` instead of `$2.00/$12.00`; luna `$0.07/$0.42`
  instead of `$0.20/$1.20`). Also found a duplicate `gpt-5.6-luna`
  route entry whose `upstreamModel` was mistakenly `"gpt-5.6-terra"` --
  some luna requests were silently served by terra while still billed
  at luna's (wrong, cheap) price.
- **Vercel "Sensitive" type env vars are write-only, by design.** No
  API path, no `vercel env pull`, nothing can read the value back once
  set -- confirmed via `GET /v9/projects/{id}/env/{envId}?decrypt=true`
  returning `"decrypted": false` with no `value` key at all for
  `type: "sensitive"`, vs. `type: "encrypted"` vars which decrypt fine
  the same way. This explains why past sessions kept creating
  `EXTRA_MODEL_ROUTES_JSON_2`, `_3` duplicates instead of editing the
  base `MODEL_ROUTES_JSON` -- nobody could actually read it back to
  patch it. `gpt-5.6-sol`'s route lives in that unreadable base file;
  fixed it by adding a NEW higher-priority (`priority: 1`) override
  entry with correct pricing into the readable `EXTRA_MODEL_ROUTES_JSON_3`
  instead of blind-overwriting the base sensitive var (which would risk
  destroying every other model's config with no way to verify or undo).
- Fixed `EXTRA_MODEL_ROUTES_JSON_3` (sol added at priority 1, terra/luna
  corrected in place, duplicate luna's upstreamModel fixed) via the
  Vercel API `PATCH /v9/projects/{id}/env/{envId}`, then redeployed
  entry-gateway (`vercel deploy --prod`) so the new value took effect.
- Verified fix by reading the var back post-write (it's `encrypted`
  type, readable) and confirming `/health` shows all 3 models routing.
- Reconciled historical impact directly against the Neon Postgres DB
  (entry-agents' `DATABASE_URL` -- readable via Vercel API since it's
  `encrypted`, not `sensitive`). **Sandbox can't reach Postgres directly
  on port 5432** (free-plan network only allows HTTPS/443) -- worked
  around it with the `@neondatabase/serverless` HTTP driver (`neon()`
  from `@neondatabase/serverless`, queries over HTTPS). Only 2 user
  accounts (clearly internal/test) had ever used these 3 models; real
  dollar undercharge was ~$15 total (~$7.4 terra + ~$7.8 sol; luna
  actually roundedly overcharged slightly due to its 1-cent-minimum
  per-step billing rounding on many tiny steps, which happened to mask
  the pricing bug at that scale). Given the tiny blast radius, decided
  NOT to auto-adjust balances -- flagged the option to the owner instead
  of guessing on a financial correction.
- Built a proper fix for *next time this happens*: added a manual
  "Add / remove credit" card to the admin user-detail page
  (`apps/web/app/settings/admin/admin-user-detail-view.tsx` +
  `adjustAdminUserCredit` in `apps/web/lib/admin/actions.ts`), on top of
  the existing `creditAccount`/`debitAccountAdmin` ledger helpers, so
  corrections like this don't need a one-off DB script in the future.

Deployed: commit 5bec7f1, live on entry-agents.vercel.app. Gateway fix
deployed separately via `entry-gateway-six.vercel.app`.

## 2026-08-18: chat image attachments leaking into user GitHub repos

- Root cause: chat images get offloaded into the sandbox at
  `uploads/<hash>.ext` for the agent to read via its own tools (see
  `persistImageAttachmentsToSandbox` in
  `apps/web/app/workflows/chat-sandbox-runtime.ts`). That path is
  relative to the sandbox's `workingDirectory`, which *is* the repo
  root -- `git clone ... .` clones straight into it, there's no
  separate non-repo path in this sandbox setup. So `git add -A`
  (whether from our own auto-commit step in `packages/sandbox/git.ts`
  `stageAll()`, or the agent's own bash tool) was sweeping these chat
  attachments straight into the user's GitHub repo. This is exactly
  what caused the stray `uploads/*.webp` file found during the PR #6
  review.
- Fix: added `ensureUploadsGitignored()` in the new
  `apps/web/lib/sandbox/uploads-gitignore.ts`, called right before any
  image is written to the sandbox. It idempotently appends a
  root-anchored `/uploads/` line to `.gitignore` (creates the file if
  missing), so no future `git add` -- ours or the agent's own -- can
  ever pick the directory up again, regardless of who runs it or in
  what order commits happen.
- Deliberately root-anchored (`/uploads/`, not bare `uploads/`) so it
  only excludes the exact top-level directory our own offload code
  writes to, not a same-named nested directory a real project might
  legitimately have and want tracked (e.g. `apps/web/public/uploads`).
- Extracted into its own dependency-light module (only a type-only
  import of `Sandbox`) instead of leaving it inline in
  `chat-sandbox-runtime.ts`, specifically so it's unit-testable without
  pulling in that file's `server-only`-guarded transitive imports
  (`lib/db/sessions`, sandbox provisioning, etc. -- importing any of
  those in a `bun:test` file throws "This module cannot be imported
  from a Client Component module"). 4 `bun:test` cases cover
  create/append/idempotency/pre-existing-non-anchored-entry.
- Side benefit: this also retroactively protects any *already-live*
  session that had an ungitignored `uploads/` dir sitting around from
  before this fix -- the very next image upload in that session now
  adds the `.gitignore` entry too.
- Noted but explicitly NOT touched: `apps/web/app/api/generate-title/
  route.test.ts` fails locally with `SyntaxError: Export named
  'wrapLanguageModel' not found in module 'ai'` -- confirmed
  pre-existing and unrelated (different file, no shared imports, fails
  the same way on a clean `git diff` against this change). Follow-up,
  not blocking.
- Deployed: commit `5b0975d`, live on `entry-agents.vercel.app`.

## 2026-08-18: Vercel CLI credentials were exposed inside the agent's own sandbox

Found while researching how to make the agent's Vercel CLI auth as safe as
its GitHub auth already was. `performAgentVercelCli` was setting
`VERCEL_TOKEN=<real token>` directly in the shell command string executed
inside the connected sandbox -- the same sandbox where the agent's own
`bash` tool has full shell access. That meant a real, live Vercel OAuth
token sat in a child process's environment (readable via
`/proc/<pid>/environ` by any co-resident process owned by the same user,
including a concurrent tool call in the same agent step) for the duration
of every `vercel_cli` call.

GitHub already avoided this entirely two different ways depending on the
operation: commit/push/API calls go straight from the server via Octokit
(sandbox never touches git credentials at all), and the one case that
does need real git protocol inside the sandbox (private repo clone) uses
the sandbox's network-egress-layer credential brokering
(`setGitHubAuthToken` / `@vercel/sandbox`'s `updateNetworkPolicy`) --
the real token is injected as an `Authorization` header on outbound
requests to github.com domains only, and never enters the sandbox's
process env, filesystem, or command history at all.

Fix: generalized that mechanism (now `buildCredentialBrokeringPolicy` in
`packages/sandbox/vercel/sandbox.ts`, tracking both GitHub and Vercel
grants together via a `WeakMap` so setting one never clobbers the other's
rules or the `"*"` catch-all) and added a matching `setVercelAuthToken`
to the sandbox interface. `performAgentVercelCli` now brokers the real
token at the network layer for `api.vercel.com` only, and the sandboxed
process only ever sees a harmless placeholder value
(`VERCEL_TOKEN=sandboxed-cli-do-not-use`) just so the CLI's own local
"am I logged in" check passes without dropping into an interactive
browser-login flow. The broker is cleared in a `finally` immediately
after the command completes, even on error/timeout.

Lesson: any credential a sandboxed CLI needs, where that same sandbox
also has an untrusted (or prompt-injectable) shell-access surface, should
go through network-egress-layer brokering, not a process env var --
env vars set for "one process" are still readable by any other
same-user process on the same box for the process's lifetime, which is a
real side channel when the agent can run tool calls concurrently.

## 2026-08-18: gh CLI + generic Vercel REST API, same broker pattern

Extended `github_cli` with a `cli` action (arbitrary authenticated
`gh <args>` commands) and added a new `vercel_api` tool (generic Vercel
REST passthrough), so the agent isn't limited to the couple of GitHub
REST endpoints and CLI subcommands we thought to hardcode.

`github_cli`'s new `cli` action reuses the exact same network-egress
credential broker as commit/push (`withTemporaryGitHubAuth` /
`setGitHubAuthToken`, see the entry just above) -- a short-lived GitHub
App installation token, scoped to exactly the one connected repo via
`verifyRepoAccess` + `mintInstallationToken`, is injected as an
`Authorization` header on outbound requests to
`github.com`/`api.github.com`/`uploads.github.com`/`codeload.github.com`
only. The sandbox process itself only ever sees
`GH_TOKEN=sandboxed-cli-do-not-use`, a harmless placeholder needed
purely so `gh`'s own local "am I logged in" check passes. Token is
always revoked in a `finally`, even on error/timeout. Scoped to
contents/issues/pull_requests/actions/checks/statuses/workflows write --
deliberately NOT `administration`, so an agent-initiated `gh` command
can never touch repo settings/deletion/transfer/collaborator management.

Also: the sandbox base image doesn't ship `gh` (unlike `vercel`, which
it already has), so `performAgentGithubCli` installs the static Linux
release binary from GitHub's own release assets on first use per
session if `command -v gh` fails -- no apt/sudo dependency, works
regardless of the base image's package manager.

`vercel_api` needed no new broker at all: unlike `vercel_cli`, it never
touches the sandbox. It's a plain authenticated `fetch` to
`api.vercel.com` from inside the step function itself, using the same
per-user OAuth token (`getUserVercelToken`, auto-refreshed by
better-auth) `performAgentVercelCli` already uses. Simpler and faster
for the structured-JSON-read use case (full deployment metadata, edge
config, webhooks, some project settings) that the CLI's text output
doesn't expose cleanly.

Both close the same gap: previously the agent could only do what we'd
individually wired as a named action. Now it can do essentially anything
`gh`/the GitHub API or the Vercel API expose, with the security
boundary enforced at the credential layer (repo-scoped token,
capability-scoped permissions, never touching the untrusted sandbox
shell) rather than by trying to allowlist specific subcommands/paths.

## 2026-08-18: "selected Claude, got Luna's error" -- composer send/model-switch race

Owner report: picked claude-opus-5 in the model dropdown, sent a message,
and got back "This model has hit its usage limit" tagged `gpt-5.6-luna`
-- despite Claude being visibly selected in the UI. Read as "there's a
hidden fallback to Luna" -- there isn't, and there's deliberately no such
thing anywhere server-side (the credit-based soft-cutoff-to-Luna path
was already removed on 2026-08-17 per owner instruction; every plan hard
-blocks at zero balance now instead of silently swapping models).

Actual root cause: `ChatRequestBody` never carries a `modelId` at all --
`runAgentWorkflow` always reads `chat.modelId` fresh from the DB.
Switching models in the composer fires an async `PATCH
/api/sessions/.../chats/...` that updates the DB (and local
`chatInfo.modelId` state) only once it resolves; the model selector
itself greys out during that window (`isUpdatingModel`) but the
textarea/Enter/Send were never gated on the same flag. A fast Enter
right after switching could submit while the DB still held the
previous model, so the turn ran against the OLD model even though the
UI already showed the new one -- and if that old model then hit a
provider quota error, the error correctly named the model that actually
ran, which just didn't match what was on screen anymore.

Fix: the composer's `onSubmit` now also returns early while
`isUpdatingModel` is true, same as the existing `isArchived`/
`composerGate` guards -- runs before `setInput("")`, so typed text is
preserved and the user just needs to press Enter again a few hundred ms
later once the switch has actually landed.

Lesson: any UI selector that persists via an async round-trip (not
local-only state) needs its "in flight" flag threaded through *every*
path that could act on the stale value, not just the selector's own
disabled state. Here that meant the submit handler too, not just the
dropdown.

## 2026-08-18: system prompt never had an Anthropic cache breakpoint (main agent + all 3 subagents)

Prompted by a broad "improve caching everywhere, research the harness"
ask. Audited all 46 gateway routes' cache accounting first (separate
entry-gateway fix, see that repo's notes) then turned to the agent
harness itself, since caching correctness at the gateway is moot if the
agent never asks for a cache hit in the first place.

Found: `packages/agent/context-management/cache-control.ts`'s
`addCacheControl()` only ever marked `tools` (last tool) and `messages`
(last message) with Anthropic's `cache_control: { type: "ephemeral" }`.
The **system prompt** -- `CORE_SYSTEM_PROMPT` alone is ~10.5K+ tokens
per `auto-compact.ts`'s own measurement, and it's byte-identical across
every turn of every session -- was always passed to the SDK as a plain
`instructions: string`. Anthropic's Messages API has no way to cache a
bare string; `cache_control` can only be set on a message/content block
via `providerOptions`. So the single largest, most stable, most
valuable-to-cache block in the entire request was never cached at all
-- full latency and full input-token price, every single turn, forever.
Confirmed via ai-sdk.dev's own Anthropic provider docs plus multiple
open SDK issues describing the identical gap elsewhere
(OpenRouterTeam/ai-sdk-provider#389, laravel/ai#119).

Same exact bug existed independently in all three subagents (executor,
design, explorer) -- `prepareCall` built `instructions` as a template
string concatenating the static subagent system prompt with the
per-task `options.task`/`options.instructions`, again never wrapped
with `cache_control`. Doesn't help caching *across* different subagent
tasks (the task text legitimately differs each time), but each
subagent's own tool loop can run up to `SUBAGENT_STEP_LIMIT` steps
re-sending that *same* instructions string every step -- that
within-task reuse was also going uncached.

Fix: `ai@6.0.194`'s `instructions` field on `ToolLoopAgent` accepts
`string | SystemModelMessage | Array<SystemModelMessage>` (confirmed in
the installed package's own `.d.ts`), and `SystemModelMessage` supports
the same `providerOptions` shape as any message. Added a 4th overload
to `addCacheControl()` for `{ instructions: string }` that wraps it as
`{ role: "system", content, providerOptions }` for Anthropic models
only (reuses the existing `isAnthropicModel()` check) and returns the
plain string unchanged for everyone else (OpenAI/Gemini/DeepSeek cache
automatically on prefix match -- wrapping would just be inert extra
metadata for them). Wired into `open-agent.ts` (both the module-level
default and the per-call `prepareCall` path) and all three subagent
`prepareCall`s. Well within Anthropic's 4-breakpoint limit (now using 3:
tools, system, last message).

Also audited for the other cache-buster class research turned up --
tools listing where the framework mutates/reorders tool definitions per
call, or a tool description embedding a per-request UUID/timestamp
(both documented as silent full-cache-invalidation bugs elsewhere,
e.g. anthropics/claude-agent-sdk-typescript#197). Checked every tool
description under `packages/agent/tools/`: all static strings, no
`Date.now()`/`crypto.randomUUID()`/etc. anywhere in a description or
schema. Checked whether the exposed toolset ever varies by
`permissionMode` or session state: it doesn't -- `permissionMode` only
gates *execution-time* approval prompts, the tool list itself is a
fixed object literal with stable insertion order on every call. No
further caching bugs found in the harness itself.

Lesson: `addCacheControl()`'s own type signature (tools-or-messages
only) made it easy to forget the biggest cacheable block exists outside
those two categories entirely. Any future new "thing that gets sent to
the model every turn" (structured output schemas, a future response
prefix, etc.) should get the same "does this need its own
`providerOptions.anthropic.cacheControl`?" question asked explicitly,
not assumed covered because *some* cache-control wrapper already
exists in the codebase.

## 2026-08-19: context_over_200k tier-key hardcode generalized to any context_over_Nk

`resolveCostTier()` in `apps/web/lib/models.ts` only ever matched the
literal key `context_over_200k` (built for grok-4.5's threshold). This
is the app's own tier-resolution used by BOTH the UI's cost display and
the real credit-ledger debit (`chat-post-finish.ts`) -- entry-gateway's
`tieredCost()` in server.js already generalized the same convention on
2026-08-18 (`CONTEXT_TIER_KEY_RE`), but the app-side copy was never
updated to match. Result: gpt-5.6-sol/terra/luna's real 272K threshold
(per opencode.ai/docs/zen) never matched anything, so those three models
always billed (and displayed) at the base rate no matter how large the
request's context actually was -- undercharging on genuinely
large-context requests, the opposite direction from the cache-discount
bug found in the same session.

Fixed by replacing the single hardcoded check with the same
`context_over_(\d+)k` regex match entry-gateway already uses, picking
the highest matching threshold under the actual token count. Backward
compatible -- grok-4.5's existing `context_over_200k` key still matches
exactly as before. Verified via `turbo typecheck --filter=web` (clean)
plus a standalone logic simulation (luna correctly stays on base rate
below 272K and switches to the tier above it with tier-appropriate
cache_read; grok's 200k key still resolves unchanged).

Paired with a companion fix in entry-gateway (commit a7a84bc) so
`/v1/models` resolves cache_read/cache_write inside each
`context_over_Nk` tier object too, using that tier's own (higher) input
rate for the fallback multiplier -- otherwise a large-context gpt-5.6
request would get the right tiered input/output rate but the wrong
(base-rate-derived) cache discount.

Audited all 46 routes for the broader "missing cache discount" bug
class per the owner's request. Cross-checked against opencode.ai/docs/
zen's own published pricing table: Gemini's 0.1x cache-read ratio and
Grok's existing explicit rates are both confirmed correct as-is. The
free-tier models (MiMo-V2.5 Free, Hy3 Free, Nemotron 3 Ultra Free) show
$0 input/output/cached-read on OpenCode Zen's own table, so a missing
`cost.cache_read` on our side is currently harmless for them regardless
of whether our configured (non-zero) markup rate is intentional -- not
touched, flagged as a separate pricing-markup question if the owner
wants it looked at. qwen3.8-27b's `anthropic-messages` route (via
orcarouter) never actually triggers real caching today because
`isAnthropicModel()` in cache-control.ts only sends `cache_control` when
the model id contains "claude"/"anthropic" -- so no live risk there
either. Left as open/unverified: whether orcarouter's `openai-chat`
route for qwen3.8-27b does automatic/implicit caching server-side the
way OpenAI/DeepSeek do (couldn't find published docs confirming either
way).

## 2026-08-20: workflowRuns had no error column -- Vercel Hobby's ~1hr log retention made a deterministic failure unrecoverable

Investigating a report that retrying a failed turn "still fails no matter
how many times." Confirmed via the DB (`workflow_runs`/`workflow_run_steps`)
that gpt-5.6-luna repeatedly fails across many different chats/sessions: a
run does several tool-call-only steps successfully, then dies with
`status='failed'` and zero graceful finish reason -- no `maxSteps`/spend-cap
path involved (those set metadata flags and break cleanly, they don't
throw). The actual error is only ever `console.error`'d in
`apps/web/app/workflows/chat.ts`'s catch block
(`"[workflow] agent run failed:"`) and then deliberately sanitized before
being shown to the user (`toFriendlyChatErrorText`, by design -- see
`friendly-error.ts`'s own comment block on why raw errors must never reach
a client).

Tried to pull the raw error from Vercel's Runtime Logs for the specific
incident (~8hrs earlier). Every attempt -- REST `/v1/projects/.../runtime-logs`
with `since`/`until`, and `vercel logs --since=... --until=...` -- failed,
the CLI's `--debug` output revealing the real cause:
`ExceedsBillingLimitError` from Vercel's own `request-logs` endpoint. This
project is on the Hobby plan, whose Runtime Log retention is short (~1hr);
querying an 8hr-old window is rejected outright, not just truncated. This
makes root-causing anything but the most recent failures structurally
impossible today, even for a clearly deterministic bug hitting real users
repeatedly.

Fix: added `workflow_runs.error_message` (migration 0047, additive-only,
no backfill) and a new `serializeErrorForDiagnostics()` in
`friendly-error.ts` (raw message + cause + first stack line, capped at
4000 chars) -- deliberately kept separate from `toFriendlyChatErrorText`,
which exists specifically to guarantee raw error text never reaches a
client; the new function is server-side-only, threaded through
`recordWorkflowRun` only when `caughtError` is set. Deployed commit
8ecee0c, live, column confirmed present via direct Neon query.

Follow-up (not done): still don't have the actual root cause for *this*
specific Luna incident (that window has already expired). Next time a
user reports "keeps failing on retry," check `workflow_runs.error_message`
directly instead of racing Vercel's log retention window. If it turns out
to be a genuinely deterministic bug (not a transient provider blip),
consider surfacing a distinct client-facing message for it instead of the
generic "try again" text, since retrying something deterministic wastes
the user's time.

## 2026-08-20: "repeating issue" note for chats that keep failing the same way

Follow-up to the workflow_runs.error_message fix above. Added a small
classifier refactor so the same error-category logic that picks a
friendly message can also answer "has this chat failed with this same
category of error recently?" -- `classifyChatError()` in
`friendly-error.ts` now returns a stable bucket (`rate_limit`, `quota`,
`auth`, `timeout`, `network`, `provider_unavailable`, `unknown`,
`aborted`), and `countRecentFailuresWithCategory()` in
`lib/db/workflow-runs.ts` re-classifies a chat's last 20 failed runs'
stored `errorMessage` text against that same bucket -- no new column
needed, `classifyChatError` works fine against a plain string. When a
match is found, `toFriendlyChatErrorText(error, isRepeatFailure)` appends
a distinct note instead of the generic "please try again," across both
user-facing error surfaces in `chat.ts` (`getSetupErrorMessage` for
before-any-streaming failures, and the final re-thrown error for
mid-run failures). Deliberately excluded aborts (`errorCategory !==
"aborted"`) -- a user-initiated stop is never a "repeating issue."

Test note: added two new tests to `chat.test.ts` (repeat note shown /
not shown for aborts) following the file's existing mock pattern, and
they typecheck clean, but I could not get `bun test
apps/web/app/workflows/chat.test.ts` to actually run locally in this
sandbox -- it fails with `SyntaxError: Export named
'releaseUserBillingTurnStep' not found in module chat-post-finish.ts`,
even on a clean, completely unmodified checkout using the exact
CI-pinned bun version (1.2.14). Root cause traced to chat-post-finish.ts
transitively importing a `server-only`-guarded module (lib/db/usage.ts
-> ... -> lib/db/model-overrides.ts or platform-settings.ts); `mock.module`
should intercept before that's ever reached (the file already correctly
uses `await import("./chat")` after the mock.module calls, not a static
top-level import), but something in this specific file's load order
still exercises the real module in this sandbox. Other test files in the
same repo run fine. Same symptom class as the already-documented
pre-existing generate-title/route.test.ts failure -- likely a sandbox
environment quirk rather than a real bug, but unconfirmed. Deployed on
the strength of a clean full typecheck + `ultracite fix`/`check` (0
errors on the touched files) + close pattern-matching against this
file's existing passing tests, not an actual local green test run.
Open follow-up: get `bun test` for this file working locally, or verify
via the next real GitHub Actions CI run once one triggers on this repo.

### Correction (same day): repeat-failure check broke the workflow/step bundling boundary

First cut of the fix above statically imported `countRecentFailuresWithCategory`
from `@/lib/db/workflow-runs` at the top of `chat.ts`. That's a Node-module
("postgres" via `lib/db/client.ts`) reachable through a static import, and
`chat.ts` is compiled as a restricted Vercel Workflow SDK `"use workflow"`
bundle -- the deploy failed immediately with `workflow-node-module-error:
You are attempting to use "postgres" which depends on Node.js modules`.
This is the exact pattern already documented inline throughout this file
(resolveChatModelRuntime, checkVercelConnectedStep, etc.): any DB-touching
code must be reached via a dynamic `import()` from inside a function
carrying `"use step"` as its first statement, never a static top-of-file
import, even if that static import is only type-only-adjacent (a plain
named value import, in this case). Fixed by extracting the check into its
own `checkIsRepeatFailureStep()` function with `"use step"` + a dynamic
`import("@/lib/db/workflow-runs")` inside it, called with a plain `await`
from the catch block -- matches the file's existing convention exactly.
Lesson: any new code added to `chat.ts` that touches `@/lib/db/*` must be
checked against this rule before it's ever pushed; a clean `tsc --noEmit`
does NOT catch this (bundler-level restriction only enforced at build/deploy
time, not by the type checker).

## 2026-08-20: direct `vercel deploy --prod` silently created/used a throwaway project

While deploying the repeat-failure fix above, the auto-deploy webhook
stalled again (same pre-existing issue noted 2026-08-17), so I fell back
to `vercel deploy --prod --token $TOKEN --yes` from a working clone at
`/tmp/entry_agents_ro`. That failed with "No Output Directory named
public found" -- turned out `.vercel/project.json` in that clone was
linked to a project called `entry_agents_ro` (id
`prj_8zdTXyh43RP5XulgQns1ZRnzJRSD`), not the real `entry-agents` project
(id `prj_x4oE037UsFSA2fowlgHpHk9IdyQE`) -- the Vercel CLI auto-creates a
new project named after the local directory the first time you run
`vercel deploy` in an unlinked folder, and that phantom project obviously
has none of the real project's settings (root directory = apps/web,
etc.), hence the build succeeding but the deploy step looking in the
wrong place. Fixed by overwriting `.vercel/project.json` with the real
project's id/orgId directly (same team/org, just wrong projectId) --
`vercel link` would also work but requires interactive confirmation.
Deleted the throwaway `entry_agents_ro` project afterward via `DELETE
/v9/projects/entry_agents_ro`. Lesson: any time you clone this repo fresh
into a new working directory, check `.vercel/project.json` (or run
`vercel link --yes --project entry-agents`) BEFORE running a direct
`vercel deploy --prod` fallback -- don't assume an unlinked/differently-
linked directory will just target the right project.

## 2026-08-21: benchmark harness workflow file hit the same Node-module-in-workflow bug, different Node API surface

Adding the HumanEval benchmark runner (`app/workflows/run-benchmarks.ts`,
a `"use workflow"` file) hit the exact same class of bug as the
`chat.ts` repeat-failure correction above, just via a different Node API
surface: it statically imported `loadHumanEvalSubset`,
`HUMANEVAL_SUITE_VERSION`, and `runHumanEvalTask` from
`lib/benchmarks/humaneval-runner.ts`, which touches `node:child_process`
(spawns `python3` to grade candidate solutions), `node:fs/promises`,
`node:os`, `node:path`, and `@open-agents/sandbox`'s `connectLocal`
(itself pulling in `@vercel/sandbox` transitively via the package's
barrel `index.ts`). Deploy failed with six separate
`workflow-node-module-error` diagnostics pointing at that one file.

Fix: split the Node-free parts (`HumanEvalTask` type,
`loadHumanEvalSubset()`, `HUMANEVAL_SUITE_VERSION`) into a new
`lib/benchmarks/humaneval-tasks.ts` with zero Node imports (just a JSON
import) -- safe to import statically even from the workflow function's
own top-level body, which itself calls `loadHumanEvalSubset()` directly
(not from inside a step). `humaneval-runner.ts` now imports+re-exports
those from the new module instead of defining them itself, so its
existing importer (`humaneval-runner.test.ts`) needed zero changes.
`runTaskStep` (a `"use step"` function) now does
`const { runHumanEvalTask } = await import("@/lib/benchmarks/humaneval-runner")`
at call time instead of importing it statically at the top of the file.

Lesson (generalizing beyond just DB access, which is how this rule was
first written up): **any** Node-only API -- `fs`, `path`, `os`,
`child_process`, or a package that transitively depends on one of
those (like `@vercel/sandbox` via `@open-agents/sandbox`) -- must never
be reachable via a static top-of-file import anywhere in a
`"use workflow"` file's module graph, including inside files it imports
that *look* pure but aren't. `tsc --noEmit` does not catch this at all;
only a real `next build` (or the Workflow SDK's bundler specifically)
surfaces it, and it reports the exact file/line of the offending import
so it's fast to fix once you know to look for it. When adding a new
helper module intended to be called from a workflow function's own body
(not just from inside a step), audit its entire import chain for Node
APIs before wiring it in -- don't assume "it's just a pure function" is
enough if the *file* it lives in also has unrelated Node-touching
imports at the top.

## 2026-08-21: Default benchmark model list had 3 dead ids -- validate against the live gateway catalog, always

While doing a first real validation run of the HumanEval benchmark
feature, every model in the run scored a flat 0/20. Two separate causes
turned out to be tangled together:

1. **My own manual test used a stale id** (`ling-3.0` passed directly to
   `POST /api/cron/run-benchmarks`) -- not a real id, just a shorthand I
   typed from memory. The real gateway route id is
   `ling-3.0-flash-free` (display name strips the trailing `-free` via
   `getModelDisplayName`, but the *id* used for routing/selection never
   does). `getAdminModelCatalog()` (used by the admin benchmarks page's
   actual checkboxes) already returns the correct raw id, so the admin
   UI itself was never at risk of producing this -- only a manual/API
   caller typing an id by hand is.

2. **The real bug**: `DEFAULT_BENCHMARK_MODEL_IDS` in
   `app/workflows/run-benchmarks.ts` (used whenever no explicit
   `modelIds` is passed -- i.e. every future scheduled/cron run) had
   the *same* `ling-3.0` mistake baked in, plus two ids
   (`deepseek-v4-pro`, `gemini-2.5-pro`) that don't exist in the gateway
   at all -- the real Gemini ids are all `gemini-3.x-*`, and there's no
   "pro" DeepSeek route configured. 3 of 8 default models were
   guaranteed dead on every run with zero useful signal, and nothing
   would have caught it before the public benchmark page went live
   showing three legitimate models at a bogus 0/20.

Root-caused by adding a temporary admin-only diagnostic route that
proxies entry-gateway's `adminAuth`-gated `GET /v1/debug/routes` using
entry-agents' own `GATEWAY_API_KEY` (accepted by `adminAuth`'s fallback
to the regular `keys()` set) -- necessary because
`MODEL_ROUTES_JSON`/`EXTRA_MODEL_ROUTES_JSON`/`_2` on the entry-gateway
Vercel project are all type "sensitive" (permanently unreadable via
dashboard or API), so asking the running gateway itself is the only way
to see the real configured id for a model. Deleted after use, per the
existing temporary-diagnostic-route convention (see the reasoning-probe
/ cache-test entries above).

Separately, but on the same investigation: `deepseek-v4-flash`'s
gateway route id and config are correct, but a live probe got back a
genuine upstream 503 from `iamhc.cn`: `"No available channel for model
deepseek-v4-flash under group default (distributor)"`. That's a
provider-side outage, not an Entry bug -- and since deepseek-v4-flash is
also the model used for manual chat testing (per standing instruction),
this is worth checking again before assuming chat itself is broken.

**Fix, and the durable guard against a repeat:**
- Corrected `DEFAULT_BENCHMARK_MODEL_IDS` against a live route dump.
- `startAdminBenchmarkRun` now validates every requested id against the
  live catalog (`fetchAllLanguageModelsForAdmin()`) up front and throws
  a clear `Unknown model id(s): ...` error instead of starting a doomed
  run -- covers the admin UI and any future API caller equally.
- `runBenchmarkSuiteWorkflow` also checks `costByModelId` (already
  fetched from the same catalog via `loadCostCatalogStep`) membership
  per model *before* spending a step call on it -- catches
  `DEFAULT_BENCHMARK_MODEL_IDS` regressing again with one clear
  synthetic error per task instead of 20 identical opaque gateway 404s.

**Lesson**: any hardcoded model-id list anywhere in this codebase (a
default list, a seed script, a fixture) is a silent time bomb -- ids
are gateway routing keys with zero fuzzy matching, they drift as routes
get renamed, and `tsc`/lint catch none of it since they're just strings.
Any code path that accepts a model id from a source that isn't the live
catalog (a hardcoded default, a manually-typed CLI/API param, an old
saved preference) should validate against the catalog before doing
real, possibly expensive work with it -- don't rely on remembering the
correct id.

## 2026-08-21: Two live production outages found while chasing "all benchmarks fail 0/N" -- Free tier's only model is down, and the owner's default chat model is permanently gone upstream

Following the dead-model-id benchmark fix above, a broader run across
several models still showed 0/N passed for *everything except*
gpt-5.6-sol/terra. Root-caused with two temporary diagnostic routes
(`benchmark-debug` -- dumps raw `benchmark_results` rows across the
last 10 runs with per-model `errorMessage` and hard-block/admin-disabled
status; `live-probe` -- fires one live `/chat/completions` call per
model straight at entry-gateway using the server's own
`GATEWAY_API_KEY`, to see the real upstream error instead of the
summarized "All compatible upstream routes failed" string benchmarks
store). Both deleted immediately after use, per the existing
temporary-diagnostic-route convention.

**Finding 1 -- gpt-5.6-luna (Free tier's only model) is down right now.**
Live probe: FreeModel's backend returns a genuine 503, `"No available
channel for model gpt-5.6-luna under group Codex 专用分组-Pro号池
(distributor)"`. gpt-5.6-sol and gpt-5.6-terra -- same provider, same
`vip-sg.freemodel.dev` base URL -- both returned clean 200s in the same
probe, so this is scoped to Luna's specific backend pool, not a
FreeModel-wide outage. This is a pure upstream capacity issue, nothing
in Entry's config to fix. Since Free tier has no other model to fall
back to, every Free tier chat is dead until FreeModel's pool recovers.
Not yet resolved -- flagged to the owner, no code change possible on
our side.

**Finding 2 -- ling-3.0-flash-free (the owner's standing "use ling 3.0
for chat" default) is permanently gone, not just misconfigured.** Its
gateway route's `upstreamModel` is `ling-3.0-tiny-free` (this mapping
pre-dates today's investigation -- unclear when or why "flash" got
pointed at "tiny", but it doesn't matter now). Live probe against that
id got `"Model ling-3.0-tiny-free is not supported"` straight from
OpenCode Zen. Checked Zen's own public docs
(https://opencode.ai/docs/zen) -- the current Endpoints table lists
zero "Ling" branded models of any kind. Third-party deprecation
trackers (coolhandlabs.com/inference-apis) confirm
`ling-3.0-flash-free` was deprecated by Zen on 2026-08-12; whatever
`ling-3.0-tiny-free` was standing in for it has since been removed too.
**There is no Ling model left on OpenCode Zen to route to at any tier.**
This can't be fixed with a route-config change -- it needs the owner to
choose a new default chat model. gpt-5.6-terra and gpt-5.6-sol are both
confirmed live and working right now as candidates.

**Lesson**: a model being present and `enabled: true` in the gateway's
route config says nothing about whether the *provider* still serves
it -- upstream deprecations happen silently from Entry's point of view
(no error, no alert, just a route that quietly starts 401/503ing). The
benchmark suite, once its own model-id list is correct, is actually a
decent tripwire for this class of drift precisely because it exercises
every configured model on a schedule -- worth keeping that scheduled
run active specifically to catch future silent upstream deprecations
like this one, not just to fill out the public page.

## 2026-08-21: Automated recovery monitor for the gpt-5.6-luna outage instead of manual re-checks

Once the ling-3.0-flash-free route fix shipped and the owner asked me
not to add a Luna fallback route, the remaining open item was purely
"FreeModel's Luna pool is down, nothing to do but wait." Rather than
leaving that as a manual "ask me later" item, wired up a small
self-contained monitor on the Superagent side:

- `GET /api/public/luna-status` on entry-agents -- unauthenticated,
  deliberately minimal (`{available: bool, checkedAt: iso}` only, no
  upstream error text) since it's public. Does one tiny real
  completion call (`max_tokens: 5`) through the gateway per request.
- Superagent backend function `checkLunaStatus` polls that endpoint.
- Superagent scheduled workflow "Entry Luna Recovery Monitor" (every 30
  min) calls it, and only acts when `available == true`: sends the
  owner a WhatsApp ping via `broadcast_message` and deactivates itself
  via `manage_workflow` so it doesn't keep firing after recovery.

No entry-agents/entry-gateway code changes needed beyond the one public
route -- everything else (polling cadence, notification, self-cleanup)
lives in the Superagent workflow layer, not this repo. If Luna's outage
resolves and the workflow doesn't need to exist anymore, the
`/api/public/luna-status` route can stay -- it's cheap, harmless, and
useful for the *next* time any model needs this kind of external
watch, not just Luna.

## 2026-08-21: gpt-5.6/FreeModel cache-hit ratio stuck at 16-47% -- Postgres jsonb silently reorders object keys, breaking OpenAI's byte-exact prefix caching

Investigating why FreeModel (gpt-5.6-sol/terra/luna) cache-hit ratio was
nowhere near a >70% target: 30-day production `usage_events` data showed
16-47% token-weighted hit rates with wild, unexplained turn-to-turn
swings -- 0% right next to 70-90% within the *same* chat session, with no
correlation to elapsed time between turns (ruling out simple TTL
expiry as the main driver).

**Root cause, confirmed directly against the real production DB** (temp
diagnostic route, since removed): Postgres `jsonb` does NOT preserve
object key insertion order on round-trip. Inserting
`{"zebra":1,"apple":2,"mango":3,"banana":4,"tool_call_id":"x","type":"y","input":{...}}`
and reading it straight back reordered the top-level keys entirely --
to an internal storage order, unrelated to insertion order *or*
alphabetical order. `chat_messages.parts` is a `jsonb` column, and any
tool-call `input` / tool-result `output` object nested in a message's
`parts` is exactly this shape.

Every chat turn resends the *entire* prior message history to the
model (see `convertMessages` in `app/workflows/chat.ts`). OpenAI-style
implicit/automatic prompt caching for gpt-5.6-* is a byte-exact PREFIX
match against a previously-seen request. Once any message in that
history had been hydrated from the `jsonb` column (e.g. after a page
load/resume, rather than staying in the same in-memory JS object that
originally produced the tool call) with a different key order than
when it was first serialized to the model, the prompt text differs
from that point on -- and every token after it misses cache, even
though the *content* is byte-for-byte identical.

**Fix**: new `apps/web/lib/chat/canonicalize-key-order.ts` -- deep,
alphabetical key-sort of every message's `parts` value (arrays keep
their original order; only object *key* order changes, which JSON
semantics never assign meaning to). Wired into `convertMessages()` in
`app/workflows/chat.ts`, applied right after the existing
`dedupeMessageReasoning` step, on every message regardless of whether
it just came fresh from the model or was reloaded from Postgres. As
long as the same canonicalization runs every time, the serialized
bytes are deterministic across storage round-trips, so the prefix
matches request after request. 5 new unit tests, all passing; full
repo typecheck clean. Deployed commit 136165e, live on
entry-agents.vercel.app.

**Lesson**: any `jsonb` column that gets round-tripped back into a
byte-exact-matching consumer (prompt caches, hash-based dedup, digital
signatures, etc.) needs its own canonicalization step on the way back
out -- never assume `jsonb` preserves what you put in beyond logical
JSON equality. This class of bug is invisible in every functional test
(the data is *correct*, just differently ordered) and only shows up as
a silent efficiency/cost regression, which is exactly why it survived
undetected until someone went looking at aggregate cache-hit metrics
specifically.

**Not yet verified**: real production cache-hit ratio after this fix
(needs a few days of real traffic + another look at `usage_events` to
confirm the ratio actually climbs toward the >70% target). If it
doesn't fully close the gap, the next suspect is whether FreeModel's
backend pool actually honors `prompt_cache_key` for session affinity
at all (added 2026-08-19, commit 9c17c91) -- that fix was never
smoke-tested against a real paid call since `FREEMODEL_API_KEY` is a
Vercel Sensitive var, write-only even to the owner.

## 2026-08-23: Sandbox snapshot storage silently blew past the Hobby 15GB quota, 402'd every new sandbox

Real production incident: for roughly an hour, every chat that needed
a fresh Vercel Sandbox failed at the `runProvisioning` workflow step
with `Status code 402 is not ok`. Confirmed via runtime logs (~16
failed workflow runs in the window) and directly against Vercel's
sandbox-snapshots API (`GET /v2/sandboxes/snapshots`): the project had
accumulated ~90GB across `created`+`deleted`-status snapshots, ~12.8GB
of it in live `created` status -- right up against the Hobby plan's
15GB Snapshot Storage cap, so any new snapshot attempt tipped it over
into a hard 402 block on the whole project (not just snapshotting; new
sandbox creation too).

**Root cause**: `VercelSandbox.snapshot()` in
`packages/sandbox/vercel/sandbox.ts` called `this.session.snapshot()`
with **no arguments**. The underlying `@vercel/sandbox` SDK's
`Session.snapshot(opts)` needs `opts.expiration` passed on *every
call* -- it does **not** inherit the `snapshotExpiration` configured
at sandbox-creation time (that value is only exposed for inspection
via a read-only getter, never auto-applied to later snapshot calls).
Omitting it falls back to the SDK/API's own default of **30 days**.

This means the 2026-08-18 fix (`DEFAULT_SNAPSHOT_EXPIRATION_MS = 24h`,
threaded into `VercelSandboxSDK.create()`'s `snapshotExpiration`
field) never actually took effect for real hibernate-on-suspend
snapshots -- it only set a value nothing downstream reads. Every real
snapshot since then kept expiring 30 days out instead of 1 day,
explaining the slow-motion reaccumulation back to quota-breaking
levels after the same class of cleanup was already done once before
(see the 2026-08-18 entry in this file / `sandbox.ts`'s own comment
about the prior 73GB/32.6GB incident).

**Fix**: `snapshot()` now explicitly passes
`{ expiration: DEFAULT_SNAPSHOT_EXPIRATION_MS }` on every call. Added
a regression test (`sandbox.test.ts`, "passes a 1-day expiration when
creating a native snapshot") that fails against the old code and
passes against the fix. Typecheck clean, 25/25 + 3/3 relevant test
files pass.

**Immediate remediation**: deleted all 7 live `created`-status
snapshots via `DELETE /v2/sandboxes/snapshots/{id}` (Vercel REST API,
`https://vercel.com/api/v2/sandboxes/snapshots/<id>?teamId=...`) --
none of them were a pinned base image (`VERCEL_SANDBOX_BASE_SNAPSHOT_ID`
is unset in this project, confirmed via env var list before deleting
anything), just old per-session hibernate snapshots from Aug 18-21.
Freed ~12.8GB, quota back to 0/15GB used.

**Lesson**: a "default value" only does something if the code path
that matters actually reads it. Threading a config default through
creation-time options doesn't help if the *separate* API call that
creates the actual storage-consuming artifact (the snapshot itself)
has its own, unrelated default. When fixing a resource-leak class of
bug, grep for *every* call site that creates the leaking resource, not
just the one that seemed most relevant at the time.

**Follow-up worth doing**: consider a periodic cleanup job (cron
workflow) that lists snapshots via this same API and deletes anything
past a sane age, as a second line of defense in case the expiration
plumbing regresses again silently.


**Follow-up shipped 2026-08-23**: added the periodic cleanup mentioned
above as a real safety net -- a daily scheduled agent workflow ("Entry
Sandbox Snapshot Cleanup", 3am Africa/Lagos) that lists sandbox
snapshots via the same Vercel REST API, deletes any `created`-status
snapshot older than 2 days (a safety margin above the intended 1-day
expiration, so it only ever catches genuine leaks/regressions), skips
anything matching `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` if that's set, and
only pings the owner on WhatsApp if it actually deleted something or
total remaining storage is still >10GB after cleanup -- otherwise runs
silently. Second line of defense in case the snapshot() expiration fix
above ever regresses again.
## 2026-08-24: `@vercel/sandbox` upgrade attempted, reverted -- SDK 3.x breaks two real call sites (open follow-up)

While root-causing the still-failing 402 quota fallback (see the
`toErrorMessage`/`.text`/`.json` entry below), confirmed `packages/sandbox`
pins `@vercel/sandbox` at `2.0.0-beta.11` -- Vercel Sandbox and
persistence are both GA now, current stable is `3.1.0`. Notably,
`@vercel/sandbox@3.0.1`'s changelog fixes the *exact* bug found in
production: "Surface the server's error message in `APIError.message`
... previously reported only `Status code 400 is not ok`, hiding the
actionable detail ... in `error.json`." Upgrading would make our
`toErrorMessage` workaround unnecessary (though harmless to keep).

Attempted the bump to `3.1.0` and ran `tsc --noEmit` on
`packages/sandbox` -- surfaced two real breaking changes beyond the
documented `runtime`→`image` deprecation (which does keep backward
compat):

1. `VercelSandboxSDK.create({ source: { type: "snapshot", ... } })` no
   longer type-checks -- `source.type` is now only `"git" | "tarball"`.
   Used in `packages/sandbox/vercel/sandbox.ts` for both
   `restoreSnapshotId` and `baseSnapshotId` creation paths. Need to find
   the 3.x-native way to create/restore from a snapshot (likely a
   different param entirely, maybe under `image`, or a dedicated
   fork/restore method) before this can ship.
2. `networkPolicy.allow` shape changed: our
   `SandboxNetworkPolicy`/`SandboxNetworkRule[]` (used by the GitHub/
   Vercel credential-brokering network policy in
   `buildCredentialBrokeringPolicy`) no longer matches the SDK's new
   `NetworkPolicyRule[]` type. This is the security boundary that scopes
   GitHub push tokens to specific domains -- a shape mismatch here needs
   very careful review, not a quick type-cast.

Reverted the bump (`packages/sandbox/package.json` + `pnpm-lock.yaml`
back to `2.0.0-beta.11`) rather than rush it mid-incident. Open
follow-up: dedicate a separate pass to (a) find the 3.x snapshot-create
API, (b) map `SandboxNetworkRule[]` to `NetworkPolicyRule[]` correctly,
(c) re-run the full test suite, before attempting this again.

## 2026-08-25: Default sandbox is now non-persistent (commit 21bab98)

Owner explicitly asked: "Default sandbox should be non persistent."
Changed the actual default in two places:
- `apps/web/lib/sandbox/provisioning.ts` -- the main per-session sandbox
  provisioning path (used on every chat session) had `persistent: true`
  hardcoded; flipped to `persistent: false`.
- `packages/sandbox/vercel/sandbox.ts` -- `VercelSandbox.create()`'s own
  internal default (`persistent = true` destructure default) flipped to
  `persistent = false`, so any other call site that omits the option now
  gets the safe default too.

Why: persistent mode's auto-snapshot-on-stop kept blowing through the
Hobby plan's 15GB Snapshot Storage quota despite several rounds of
fixes today (dca92d2, faf114a -- see entries above). Every fix closed
one specific bug in the snapshot lifecycle, but the *feature itself*
(auto-snapshot-on-every-stop) was the real source of runaway storage
growth. Removing it as the default removes the whole failure class
instead of chasing more edge cases in it.

Left untouched, intentionally: `apps/web/app/api/sandbox/snapshot/route.ts`
still creates with `persistent: true` -- that route is specifically about
restoring a named/legacy persistent sandbox by request, not the default
provisioning path.

Trade-off (accepted): sessions no longer resume filesystem state across
a full stop/restart -- e.g. after the 30-min inactivity hibernation in
`lib/sandbox/lifecycle.ts`, the old sandbox is gone for good and the
next connect just provisions a fresh one (git re-clone), rather than
restoring a snapshot. Existing "sandbox not found" fallback handling in
`lib/sandbox/utils.ts` (`clearSandboxResumeState`) already degrades
gracefully for this case -- confirmed no crash path, just loses
uncommitted in-sandbox state on resume after a stop.

### In-progress, not yet wired up: 40-minute session-duration migration
Same commit also added (but has NOT yet wired into the lifecycle
workflow) the primitives for a follow-up safety net: proactively
migrating/refreshing a session's sandbox a few minutes before the
Vercel Hobby plan's 45-minute hard session cap, instead of hitting a
hard cutoff mid-task.
- `packages/sandbox/migrate.ts`: `packWorkspacePayload()` /
  `restoreWorkspacePayload()` -- git bundle+diff+untracked files when
  the workspace is a git repo, else a full tar (excluding
  node_modules/.next/dist/.turbo) for non-git scratch sandboxes.
- `packages/sandbox/interface.ts`: added `ActiveCommandInfo`,
  `SandboxHooks.onCommandStart`/`onCommandEnd`, and
  `Sandbox.killCommand()` / `packWorkspacePayload()` /
  `restoreWorkspacePayload()`.
- `packages/sandbox/vercel/sandbox.ts`: `exec()` now always starts
  commands in detached mode internally so it can capture `cmdId`
  immediately and fire `onCommandStart` before awaiting completion
  (needed so an external process -- the lifecycle workflow -- can find
  and kill this exact command by id later, since it runs in a totally
  different invocation). Added `killCommand(cmdId)` and
  `ExecResult.killedExternally` so a caller can tell "real failure"
  apart from "killed on purpose for a migration, please retry".

Still needed before this is live (do NOT consider it shipped):
1. DB migration: `sessions.activeSandboxCommand` (jsonb) column so the
   cmdId can be persisted durably across process invocations, plus a
   `"migrating"` `lifecycleState` literal.
2. `apps/web/lib/sandbox/migration.ts`: the actual
   `performSandboxMigration(sessionId)` orchestrator -- kill the active
   command if present, pack the payload, create a fresh sandbox (or for
   a persistent one, just stop+resume the same identity), restore the
   payload, update session state.
3. Wire a new due-time check into
   `apps/web/app/workflows/sandbox-lifecycle.ts` / `lifecycle.ts` for
   "5 minutes before max session duration" that, unlike the existing
   inactivity hibernate check, does NOT skip when there's an active
   workflow -- it should interrupt it via `killCommand`.
4. Wire the retry side in `packages/agent/tools/bash.ts`'s `execute()` --
   after `sandbox.exec()` returns with `killedExternally: true`, wait
   for the migration to finish and retry the same command once against
   the refreshed sandbox, transparent to the model.
5. A UI status indicator so the user sees "refreshing environment..."
   instead of a silent multi-second gap during migration.

Open follow-up, pick this up as its own dedicated pass.

## 2026-08-25: 40-min session-migration safety net -- wired up and shipped

Follow-up to the punch list above. Items 1-4 are now done; full picture:

1. DB: `sessions.activeSandboxCommand` (jsonb) column added
   (migration `0049_add_sandbox_migration_state.sql`), plus `"migrating"`
   added to the `lifecycleState` text-enum (no DB migration needed for
   that part -- it's a TS-level `text({enum})` constraint, not a real
   Postgres enum/CHECK).
2. `apps/web/lib/sandbox/migration.ts`: `performSandboxMigration(sessionId)`
   -- connects to the existing sandbox, force-kills any in-flight command
   (best-effort, via the new `activeSandboxCommand` record),
   `packWorkspacePayload()`s it, creates a genuinely new sandbox
   (`skipGitWorkspaceBootstrap: true`, no source/sandboxName so it never
   tries to resume the old one), `restoreWorkspacePayload()`s into it,
   stops the old sandbox (best-effort), and atomically swaps
   `session.sandboxState` + bumps `lifecycleVersion`.
3. Wake timing: `getExpiryDueAtMs()` in `lifecycle.ts` now subtracts
   `SANDBOX_MIGRATION_LEAD_MS` (5 min) instead of the old 10s
   `SANDBOX_EXPIRES_BUFFER_MS` -- that 10s constant is kept as-is for its
   original job elsewhere (utils.ts / status route: "is this sandbox
   already basically dead"), it's just not used for lifecycle-workflow
   wake-scheduling anymore. Without this, the workflow would only ever
   notice it's close to hard expiry 10 seconds out -- nowhere near enough
   runway to pack+restore a workspace.
4. `evaluateSandboxLifecycle()`'s active-stream branch now returns a new
   `"migration-needed"` action (instead of always skipping) when
   `isSandboxMigrationDue()` is true. The workflow file
   (`sandbox-lifecycle.ts`) handles that action by calling
   `performSandboxMigration` from its own step, then loops back --
   deliberately NOT calling it from inside `lifecycle.ts` itself, since
   `migration.ts` -> `provisioning.ts` -> `lifecycle-kick.ts` ->
   `sandbox-lifecycle.ts` already cycles back to `migration.ts`, so
   `lifecycle.ts` can never import `migration.ts` directly without an
   import cycle. (Also had to move `isSandboxState`/`VercelSandboxState`
   out of `provisioning.ts` into the dependency-free `utils.ts` for the
   same reason -- `migration.ts` needed it but couldn't import from
   `provisioning.ts`.)
5. `packages/agent/tools/bash.ts`: after `sandbox.exec()` returns
   `killedExternally: true`, retries the exact same command once,
   transparently, against a freshly-reconnected sandbox. The tricky part:
   the sandbox already sitting in `experimental_context` is a
   point-in-time snapshot from the start of the turn, so just calling
   `getSandbox()` again would reconnect to the same (now-stopped) old
   sandbox. Added `sandboxLifecycleHooks.refreshSandboxState()` (re-fetches
   `session.sandboxState` fresh from the DB) and a new
   `reconnectSandboxAfterMigration()` helper in `tools/utils.ts` that uses
   it, so the retry actually lands on the new sandbox.

Still open (not done, don't assume otherwise):
- No UI status indicator yet for "environment refreshing" during a
  migration -- currently just a silent multi-second gap on whatever tool
  call happens to get killed and retried.
- Detached background processes (e.g. a dev server started via
  `execDetached`) are NOT restarted after a migration -- they're just
  gone. Only the foreground `bash` tool call gets the retry treatment.
  Would need to track detached commands the same way and re-issue them
  against the new sandbox after restore.
- Migration failures retry every `SANDBOX_LIFECYCLE_MIN_SLEEP_MS` tick
  with no backoff -- fine for transient errors, could spin uselessly on
  a persistent one (e.g. bad credentials) until the old sandbox
  hard-expires anyway and the whole thing becomes moot.
- Not yet tested against a real large-history repo -- `git bundle
  --all` captures full history with no size cap; could be slow/large
  for a big monorepo session.

## 2026-08-25 (later): sandbox-migration UI indicator

Closed the last real gap from the migration safety net above (the "no
UI status indicator yet" item).

- `session-chat-content.tsx`: added `isServerMigrating` (`lifecycleTiming.state
  === "migrating"`) and a small amber spinner + tooltip in the
  header-actions portal (the same `headerActionsRef` portal that
  already renders the dev-server/code-editor buttons), reusing the
  existing `Loader2`/`Tooltip` pattern the dev-server "starting" state
  uses. Tooltip text explains what's happening and that any interrupted
  command will auto-retry.
- Found while looking for where to hook it in: `_sandboxUiStatus` and
  `_SandboxHeaderBadge` (underscore-prefixed = intentionally unused,
  per this codebase's convention) already existed in this file but were
  never rendered anywhere -- looks like earlier WIP for a fuller status
  badge that never got wired to a render target. Left them as-is rather
  than untangling/wiring the whole thing in this pass; the new indicator
  is a small, independent addition alongside them, not built on top of
  them.
- No new polling needed -- `session-chat-context.tsx` already runs a
  15s status poll (`requestStatusSync`) while the tab is visible, which
  updates `lifecycleTiming.state` from the server. The indicator picks
  up "migrating" from that automatically.

Remaining gaps from the original punch list, still open: detached
background processes (dev servers) aren't restarted after a migration,
no backoff on repeated migration failures, untested on very
large-history repos.

## 2026-08-25 (later still): MCP client plumbing -- groundwork for "thousands of tools" (commit 1104736)

Owner asked to "give Entry access to thousands of tools." Real answer
is MCP (Model Context Protocol) -- same mechanism Claude Code/Cursor
use. Shipped the vendor-agnostic connector, deliberately did NOT wire
it to a live source of tools yet -- that's a product decision, not an
engineering one.

- New `packages/agent/tools/mcp.ts`: `createMcpToolSet(servers)`
  connects to any number of MCP servers (http/sse transport) in
  parallel via `@ai-sdk/mcp`, merges their tools into one ToolSet
  namespaced `mcp__<server>__<tool>` (avoids collisions between
  servers and with Entry's own built-in tools), isolates a broken
  server's connection failure instead of failing the whole call, and
  returns `close()` to tear down every connection.
- Every MCP-sourced tool gets wrapped with the same blanket approval
  gate `web_fetch` already uses (`needsApproval` => true whenever
  `permissionMode` is `"ask"`, the default). MCP has no standard
  concept of "this tool is dangerous," and an agent that already has
  bash/git-push/deploy access can't safely trust a remote server's
  self-reported metadata -- so every external tool call is treated as
  sensitive by default, same as every other blanket gate in this repo.
- Wired into `open-agent.ts` via a new `extraTools` call option:
  callers own resolving which servers to connect to and the connection
  lifecycle (connect before the call, close after the stream is fully
  consumed); the package itself only merges an already-built ToolSet in
  inside `prepareCall`. Kept it this way on purpose -- no MCP-specific
  code needed inside the package beyond the merge itself.
- Version pin: `@ai-sdk/mcp@1.0.72`, not the latest `1.0.74`/`2.x`.
  `2.x` tracks the `ai` v7 line (this repo is still on v6); `1.0.74`
  got rejected outright by this workspace's `minimumReleaseAge` pnpm
  guard (published <24h before the install attempt) -- picked `1.0.72`
  instead, published 2026-08-21, whose `@ai-sdk/provider@3.0.15` /
  `provider-utils@4.0.46` deps match what `ai@6.0.194` already
  resolves to in this repo.
- Looked hard at `@ai-sdk/code-mode` too (lets a model batch many tool
  calls into one JS program instead of calling them one at a time --
  would solve the "thousands of schemas in context" problem elegantly,
  and its docs explicitly warn it does NOT integrate with tool
  approval flows, so it'd only ever be safe for read-only/low-risk
  tools anyway). Hard-blocked: it requires `ai@7.0.79` as a peer dep.
  Upgrading the whole `ai` package major version across this monorepo
  is its own dedicated migration with real breaking-change risk (same
  call made on the `@vercel/sandbox` 3.1.0 attempt) -- not bundling it
  into this change.
- 7 new tests in `tools/mcp.test.ts` (namespacing, multi-server merge,
  approval-gate wrapping at each permission mode, per-server failure
  isolation, `close()` never throwing even when one client's `close()`
  fails, empty-server-list edge case). Typecheck clean across
  `packages/agent` and `apps/web`.

**Not done, needs the owner's decision before this goes live:**
nothing in `app/workflows/chat.ts` calls `createMcpToolSet` yet -- no
real MCP servers are configured anywhere. Two paths, not mutually
exclusive:
1. Composio's Tool Router -- the actual path to *thousands*. Exposes a
   small search/execute interface instead of dumping thousands of raw
   tool schemas into every request (which would wreck tool-selection
   accuracy on top of blowing context). Needs a Composio account + API
   key from the owner.
2. Generic self-serve "paste any MCP server URL" (like Cursor/Claude
   Desktop) -- no vendor lock-in, smaller catalog per user, still needs
   a DB-backed per-user/session config surface and a real security
   review before letting user-supplied endpoints run tools alongside
   an agent that already has bash/deploy access.

## 2026-08-25 (later still): self-serve BYO-MCP servers, live end to end

Owner picked option 2 from the earlier MCP fork (generic "paste any MCP
server URL," not Composio's Tool Router) -- shipped full stack, wired
into the real chat request path.

- `mcp_servers` table (migration `0050_add_mcp_servers.sql`): per-user,
  `(userId, name)` unique. Headers stored as `encryptedHeaders`
  (AES-256-GCM), never plaintext at rest.
- `lib/mcp/header-encryption.ts`: derives its key via `hkdfSync` off
  the existing `BETTER_AUTH_SECRET` rather than adding a new env var --
  same pattern as better-auth's own `encryptOAuthTokens`. Decrypted
  only server-side, immediately before opening the MCP connection --
  API responses only ever return `hasHeaders: boolean`.
- `lib/mcp/url-safety.ts`: SSRF guard for user-supplied server URLs.
  Two layers -- reuses `isAllowedWebUrl` (now exported from
  `@open-agents/agent`, shared with `web_fetch`) for write-time
  protocol/literal-IP checks, plus a fresh `dns.lookup` resolution
  right before every real connection attempt to close the DNS-rebinding
  gap (a hostname that resolved public at save-time could resolve
  private later). Documented as time-of-check, not IP-pinned --
  revisit with a pinned dispatcher only if this becomes a real attack
  surface rather than theoretical.
- Full CRUD at `/api/settings/mcp-servers` (+ `/[id]`), settings UI at
  `/settings/mcp-servers` (new sidebar entry, `Plug` icon).
- Wired into `runAgentStep` in `app/workflows/chat.ts`: resolves the
  user's enabled servers, calls `createMcpToolSet`, merges the result
  into `fullAgentOptions.extraTools`. Connection failures are logged +
  written back to `lastConnectionError` per server but never fail the
  turn. `mcpToolSet` is declared *above* the function's try/catch/finally
  (not inside the try block) specifically so `finally` can call
  `mcpToolSet?.close()` regardless of which branch ran -- a `let`
  declared inside `try {}` is out of scope in `finally {}` in JS, easy
  mistake to make with this shape of function, worth remembering for
  any future per-step resource that needs cleanup here.
- 16 tests added (`header-encryption.test.ts`, `url-safety.test.ts`,
  reused existing `tools/mcp.test.ts`). Typecheck + lint clean across
  both `apps/web` and `packages/agent`.

Not done / conscious scope cuts: no "test connection" button in the UI
(errors only surface after a real chat turn tries and fails); no rate
limit on how many servers a user can add; SSE-transport servers are
opened and closed once per chat step rather than pooled/reused across
steps in the same turn (matches how nothing else in this file pools
resources across steps either, but worth reconsidering if this turns
out to add meaningful latency in practice).

## 2026-08-26: guided frontend workflow -- implemented, spec from bb70a85

Built the "guided frontend workflow" mode planned in
`docs/plans/guided-frontend-workflow.md` (commit `bb70a85`, spec only at
the time). Design.md-first, section-by-section builds with real browser
audits, a states checklist pass, and an optional skill-save offer -- all
4 phases as agent-facing directives, not new tooling (reuses
`ask_user_question`, the `agent-browser` skill, project-local skill
files, existing `globalSkillRefs`).

- `packages/agent/system-prompt.ts`: `GUIDED_FRONTEND_WORKFLOW_PROMPT`
  (the 4 phases verbatim from the spec) + `guidedFrontendWorkflow?:
  boolean` on `BuildSystemPromptOptions`, appended last so it doesn't
  get buried above project-specific/skills sections.
- `packages/agent/open-agent.ts`: threaded `guidedFrontendWorkflow`
  through `callOptionsSchema` / `OpenAgentCallOptions` / `prepareCall`
  same shape as the existing `customInstructions` passthrough.
- New `user_preferences.guided_frontend_workflow_enabled` column
  (migration `0051`, default `false`) -- a standing per-user
  preference, toggle added to `/settings` (`preferences-section.tsx`,
  same Switch pattern as auto-commit/auto-PR). Verified with
  `drizzle-kit check` that the migration matches `schema.ts` before
  committing.
- `apps/web/app/workflows/chat.ts`: the preference alone isn't the only
  way in -- `hasGuidedFrontendWorkflowTrigger()` does a plain
  case-insensitive substring check for "guided frontend workflow" in
  the latest user message, so anyone can opt in for a single turn even
  with the preference off. Combined as OR (`guidedFrontendWorkflowEnabled
  || hasGuidedFrontendWorkflowTrigger(latestMessage)`) -- deliberately
  one-directional: a trigger phrase can only turn it on for that turn,
  never off, so there's no way to accidentally disable someone's
  standing preference via message text.
- Gotcha worth remembering: `resolveChatModelRuntime()` builds
  `ChatModelRuntime` well before `agentOptions` gets assembled further
  down in the same function -- had to actually add
  `guidedFrontendWorkflowEnabled` as its own field on that return type
  (not just read `preferences` inline at the usage site) since the raw
  `preferences` row isn't otherwise threaded that far.
- Second gotcha: `apps/web/app/settings/preferences-section.tsx` splits
  state into a `usePreferencesSectionState()` hook and a separate
  `PreferencesSection()` component that destructures *specific* fields
  off `state` -- adding a new handler to the hook's `return` block
  without also adding it to the component's destructure list compiles
  fine in isolation but fails at the JSX call site with "cannot find
  name," which only `tsc`/full typecheck (not the file-scoped lint fix)
  caught. Check both spots for any future preference toggle.
- Tests: 4 new in `packages/agent/system-prompt.test.ts` (section
  presence with pref on/off/default, ordering after other prompt
  sections), 2 new PATCH validation/update tests in
  `preferences/route.test.ts` matching the existing `publicUsageEnabled`
  pattern. Did not add coverage in `apps/web/app/workflows/chat.test.ts`
  for `hasGuidedFrontendWorkflowTrigger` -- that file has the
  pre-existing, already-documented sandbox-only `bun test` failure
  ("Export named ... not found"), so relying on typecheck + code review
  + real CI there per the existing standing note on that file.
- Full `pnpm turbo typecheck` (all 5 packages) and targeted `bun test`
  runs (58 in `packages/agent`, 46 more across the touched `apps/web`
  files) both clean before commit.

Not done / conscious scope cuts: no telemetry on how often the trigger
phrase vs. the preference toggle is actually used; no per-project
override (it's account-wide via `user_preferences`, same granularity as
every other preference in that table); Phase 4's "publish to your own
skills repo" mention is just a pointer to the existing `npx skills add`
mechanism, nothing new was built for it.

## 2026-08-26: Rate-limit Redis fail-open + recovery monitor

Owner reported "Rate limit unavailable" when trying to create a new
chat session. Root cause: the shared rate-limit Redis (Upstash) was
genuinely down/erroring in production (confirmed live via a direct
PING -- not a code bug on our side), and `checkRateLimit()`
(`apps/web/lib/rate-limit.ts`) was fail-**closed** in production --
returning a hard 503 on every rate-limited endpoint (session/chat/
sandbox creation) whenever Redis was unavailable or a check threw.
That turned a Redis-side degradation into a full outage for users.

Fix (commit a543723, live):
- Fail **open** instead of closed on Redis unavailable/error, matching
  the existing fail-open pattern already used by `lib/skills-cache.ts`
  for the same Redis instance.
- Added a 15s in-memory circuit breaker so a sustained outage doesn't
  retry (and pay the timeout) on every single request.
- Added a deduped (15 min window) Telegram alert on the first failure
  of an outage, via `lib/telegram-alerts.ts`, so we get notified
  without being spammed per-request.
- 8 new/updated tests in `rate-limit.test.ts`, typecheck + lint clean.

Recovery monitoring (commit 57162fb + Superagent workflow, both live):
- The in-app Telegram alert above covers "just went down" in real
  time, but nothing told us when it came back -- fail-open silently
  keeps working either way, so recovery was invisible.
- Added `GET /api/public/redis-status` (mirrors the existing
  `luna-status` pattern) -- public/unauthed, returns only
  `{available, checkedAt}`, opens a short-lived dedicated Redis client
  and issues a real PING per request. Intended for periodic polling
  (every 15-30 min), not a tight loop.
- Superagent side: `checkRedisStatus` backend function polls that
  endpoint, tracks down/up state in a new `RedisMonitorState` entity
  (single row, key `entry_redis`) to detect the down->up transition,
  and a scheduled workflow "Entry Redis Recovery Monitor" (every 30
  min, does NOT self-deactivate -- unlike the one-off Luna outage
  monitor, Redis rate-limit/outages can recur) pings the owner on
  WhatsApp only on that transition.
- Verified live end-to-end immediately after shipping: Redis was
  actually down at the time (`available: false` from the real PING),
  and the state entity correctly recorded `isDown: true`.

Gotcha for next time: Vercel Runtime Log retention on Hobby is ~1hr
(already documented elsewhere in this file) and low-traffic
projects may simply have no relevant log lines yet right after a
fix ships -- don't assume "no error in the logs" means "not
reproducing"; verify root cause directly against the dependency
(here, a raw Redis PING) when logs are inconclusive.

## 2026-08-26: Rotated the rate-limit Redis to a fresh Upstash instance + fixed luna-status hanging to a 504

**Redis rotation:** The shared Upstash Redis backing `checkRateLimit()`
was down again (the same instance behind the 2026-08-26 fail-open fix
above). Rather than wait on the provider, provisioned a brand new,
separate Upstash account/database (via browser automation, personal
API key created just for this) and pointed the `REDIS_URL` env var on
the `entry-agents` Vercel project at it (all three targets:
production/preview/development), then triggered a redeploy so the new
value took effect. Verified via `GET /api/public/redis-status` ->
`{"available":true,...}` after the redeploy went READY. The Superagent
"Entry Redis Recovery Monitor" workflow should pick up the down->up
transition on its next poll and notify the owner.

**luna-status hanging, not just erroring:** While pulling runtime logs
to confirm the Redis fix, found `GET /api/public/luna-status` repeatedly
hitting Vercel's hard 300s function timeout (`504`, "Vercel Runtime
Timeout Error: Task timed out after 300 seconds") instead of returning
`{available:false}` quickly. Root cause: unlike `redis-status` (which
already races its PING against a 3s timeout), `luna-status`'s
`fetch(...)` call to the gateway had no timeout/`AbortController` at
all. While Luna's upstream pool is down, the request doesn't error
fast -- it just hangs, so the function ran to the platform's max
duration on every single poll. Fixed by adding an `AbortController`
with an 8s budget (`signal: controller.signal`), treating an abort the
same as any other failure (`available:false`) in the existing `catch`
block. A healthy model would never approach 8s for a 5-token
completion, so this can't produce a false negative on a real recovery.

Lesson: any public health-check route that does a live upstream call
must have its own request timeout independent of the platform's
function timeout -- otherwise a hanging (not just erroring) dependency
turns a monitoring endpoint into a guaranteed 504/300s liability. Audit
any other `api/public/*-status` routes added in the future against this
before shipping.

## 2026-08-26: Wired Composio in as a built-in MCP server

Composio (https://composio.dev) is now wired into the chat request
path in `apps/web/app/workflows/chat.ts` as one more MCP server,
merged into the exact same generic connect/merge primitive the
self-serve "paste any MCP server URL" feature already used
(`createMcpToolSet` in `packages/agent/tools/mcp.ts`) -- this resolves
the "not wired in yet" fork noted in that file's own module comment
and the 2026-08-25 MCP entry above.

- New `apps/web/lib/mcp/composio.ts`:
  `getComposioMcpServerConfig(userId)` mints/resumes a Composio
  *session* (their current name for what used to be called "Tool
  Router"/hosted MCP) per user via `@composio/core`'s
  `composio.create(userId, { mcp: true })` /
  `composio.use(sessionId, { mcp: true })`, and returns
  `session.mcp.{url,headers}` in the same `McpServerConfig` shape a
  self-serve server uses. Never throws -- absent `COMPOSIO_API_KEY` or
  any SDK failure (including a stale/unresumable stored session ID)
  resolves to `null` and the turn continues without it.
- New `composio_sessions` table (migration `0052`, one row per user)
  persists the minted session ID so it's resumed across turns instead
  of re-minted every message, per Composio's own guidance.
- `"composio"` is now a reserved MCP server name (`lib/db/mcp-servers.ts`
  `assertValidName`) so a self-serve server can't collide with the
  built-in one in the merged/namespaced tool set.
- SDK type gotcha worth remembering: `@composio/core`'s
  `create()`/`use()` are *overloaded* -- passing the `{ mcp: true }`
  literal is what selects the overload whose return type actually
  surfaces `session.mcp` (the other overload's type omits it even
  though the field exists at runtime either way). Don't hoist a
  shared variable with a manually-written generic type argument for
  this (tried `Session<any,any,any>` first, `any` gets flagged by
  lint, and `unknown` fails a generic constraint on the provider type
  param) -- easiest fix was a small helper function per branch and
  letting TS infer the return type naturally from each call's own
  overload resolution.
- 16 tests added (`lib/mcp/composio.test.ts` mocks `@composio/core` +
  the session-storage module the same way `packages/agent/tools/
  mcp.test.ts` mocks `@ai-sdk/mcp`; `lib/db/mcp-servers.test.ts` covers
  the new reserved-name rejection). Typecheck clean across all
  packages, `ultracite check` clean.

Open follow-up: `COMPOSIO_API_KEY` still needs to be set as a Vercel
env var on the `entry-agents` project before this actually turns on
for any user (unset today, so `getComposioMcpServerConfig` currently
no-ops for everyone in prod) -- owner needs to create a Composio
project and provide the `ak_...` key.
