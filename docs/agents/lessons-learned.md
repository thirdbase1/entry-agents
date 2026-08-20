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
