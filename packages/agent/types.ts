import type { SandboxState } from "@open-agents/sandbox";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { z } from "zod";
import type { AgentSandboxContext } from "./open-agent";
import type { SkillMetadata } from "./skills/types";

export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TodoStatus = z.infer<typeof todoStatusSchema>;

export const todoItemSchema = z.object({
  id: z.string().describe("Unique identifier for the todo item"),
  content: z.string().describe("The task description"),
  status: todoStatusSchema.describe(
    "Current status. Only ONE task should be in_progress at a time.",
  ),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

/**
 * App-injected implementation for the github_commit_and_push tool. Packages
 * in this monorepo layer strictly downward (agent -> sandbox), so this
 * package can't reach into apps/web's DB/GitHub-App code directly -- the web
 * app builds the real `commitAndPush` closure (reusing the exact same
 * verified-commit path as the manual "Commit & Push" button and the
 * background auto-commit) and threads it through call options, same as it
 * threads `sandbox` itself.
 */
/**
 * App-injected hooks so the bash tool's sandbox connection can persist
 * {cmdId, command, cwd, startedAt} for whichever command is currently
 * running, durably enough that the sandbox-lifecycle workflow (running
 * in a totally different process, ahead of the session's hard duration
 * cap) can find and kill it before migrating the session to a fresh
 * sandbox. Same layering reason as GithubToolContext above: this
 * package can't reach apps/web's DB directly.
 */
export interface SandboxCommandGateResult {
  sandboxState: SandboxState;
  /** True when the command was held until an in-progress migration completed. */
  waitedForMigration?: boolean;
  /** Lifecycle run that performed the migration the command waited for. */
  migrationRunId?: string;
}

export interface SandboxLifecycleHooksContext {
  /**
   * Called immediately before a tool acquires a sandbox connection. The host
   * may block while a migration owns the workspace, then return the fresh
   * sandbox state so the tool never starts against the retiring VM.
   */
  beforeCommand: () => Promise<SandboxCommandGateResult>;
  onCommandStart: (info: {
    cmdId: string;
    command: string;
    cwd: string;
    startedAt: number;
  }) => Promise<void>;
  onCommandEnd: (cmdId: string) => Promise<void>;
  /**
   * Re-fetches this session's current sandboxState from the DB. The
   * bash tool calls this to reconnect to the *correct* sandbox after a
   * command comes back `killedExternally` (force-killed by the
   * sandbox-migration safety net) -- the sandbox already sitting in
   * `experimental_context` is a point-in-time snapshot taken at the
   * start of the turn and would still point at the old, now-stopped
   * sandbox, not the fresh one the workspace was actually migrated to.
   *
   * Resolves to null when the session has no sandbox state at all -- the
   * normal case for a turn that started before the workspace finished
   * provisioning (agent-first, lazy workspace). Callers must fall back to
   * the snapshot state rather than assume a value.
   */
  refreshSandboxState: () => Promise<SandboxState | null>;
}

/**
 * Host callbacks backing sandboxControlTool. apps/web implements each one
 * with the same server-side code the UI and the scheduled lifecycle workflow
 * use (kickSandboxProvisioningWorkflow / performSandboxMigration /
 * archiveSession), so there is exactly one implementation of every
 * workspace operation. All of them may reject; the tool surfaces the
 * rejection as a tool error rather than killing the turn.
 */
export interface SandboxControlContext {
  status: () => Promise<Record<string, unknown>>;
  provision: () => Promise<Record<string, unknown>>;
  reconnect: () => Promise<Record<string, unknown>>;
  migrate: () => Promise<Record<string, unknown>>;
  snapshot: () => Promise<Record<string, unknown>>;
  extend: () => Promise<Record<string, unknown>>;
  delete: () => Promise<Record<string, unknown>>;
}

export type SandboxControlToolResult = Record<string, unknown> &
  ({ success: true } | { success: false; error: string }) & { action: string };

export interface GithubApiRequestInput {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /**
   * Relative to this session's connected repo by default (resolves to
   * /repos/{owner}/{repo}/{path}) -- e.g. "pulls/12/comments",
   * "issues/3/labels". Prefix with "/" for any other GitHub REST
   * endpoint, e.g. "/user" or "/orgs/{org}/repos".
   */
  path: string;
  /**
   * Octokit-style: keys matching {templates} in the resolved path fill
   * the URL, everything else becomes query params (GET/HEAD/DELETE) or
   * JSON body fields (POST/PATCH/PUT).
   */
  params?: Record<string, unknown>;
}

export interface GithubApiResult {
  success: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

export interface GithubToolContext {
  hasRepo: boolean;
  repoOwner?: string;
  repoName?: string;
  commitAndPush: (input: {
    commitTitle?: string;
    commitBody?: string;
  }) => Promise<GithubCommitToolResult>;
  /**
   * Generic passthrough to any GitHub REST API endpoint (list/create
   * PRs and issues, comments, reviews, labels, merges, branch
   * protection, releases, etc.) -- same one-tool-many-actions shape as
   * VercelToolContext.run below. Backed by the same GitHub App Octokit
   * client as commitAndPush -- see apps/web/lib/github/client.ts
   * getOctokit(). Path resolves relative to this session's connected
   * repo unless it starts with "/".
   */
  request: (input: GithubApiRequestInput) => Promise<GithubApiResult>;
  /**
   * Runs an arbitrary `gh <args>` command in the sandbox, scoped to this
   * session's connected repo, for anything the `api` action can't cover
   * as a single REST call (e.g. `gh pr create` with its interactive-ish
   * diffing/templating, `gh run watch`, `gh release create` with asset
   * uploads, `gh workflow run` with typed inputs). Same zero-token-exposure
   * network-egress brokering as commitAndPush's git operations -- see
   * performAgentGithubCli in app/workflows/chat.ts.
   */
  cli: (input: { args: string }) => Promise<GithubRawCliResult>;
}

export interface GithubRawCliResult {
  success: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface GithubCommitToolResult {
  committed: boolean;
  pushed: boolean;
  commitSha?: string;
  commitUrl?: string;
  error?: string;
}

/**
 * Normalized result for the unified github_cli tool (see
 * tools/github.ts githubCliTool) -- a single shape covering both
 * actions so the model gets one consistent result format regardless of
 * which action it called, mirroring VercelCliToolResult below.
 */
export interface GithubCliToolResult {
  success: boolean;
  action: "commit_and_push" | "api" | "cli";
  committed?: boolean;
  pushed?: boolean;
  commitSha?: string;
  commitUrl?: string;
  status?: number;
  data?: unknown;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * App-injected implementation for the vercel_cli tool -- same pattern as
 * GithubToolContext above. apps/web builds the real `run` closure (fetches
 * a fresh per-user Vercel OAuth token plus the Vercel project already
 * linked to this repo, then runs the command in the sandbox with them set
 * only for that one process's environment) and threads it through call
 * options. packages/agent has no DB or Vercel OAuth access of its own, so
 * this degrades to a clear error instead of failing silently when nothing
 * is injected.
 */
export interface VercelToolContext {
  connected: boolean;
  run: (input: { args: string }) => Promise<VercelCliToolResult>;
  /**
   * Generic passthrough to any Vercel REST API endpoint, for the (few)
   * things the CLI doesn't expose directly -- e.g. reading full
   * deployment/build metadata as JSON, edge config, webhooks, project
   * settings. Same shape as GithubToolContext.request. Path resolves
   * relative to https://api.vercel.com unless it already starts with
   * "/v" (versioned Vercel API paths, e.g. "/v13/deployments/{id}").
   */
  request: (input: VercelApiRequestInput) => Promise<VercelApiResult>;
}

export interface VercelCliToolResult {
  success: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface VercelApiRequestInput {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** e.g. "v13/deployments" or "v9/projects/{id}/env". Leading "/" optional. */
  path: string;
  /** Query params (GET/DELETE) or JSON body fields (POST/PATCH/PUT). */
  params?: Record<string, unknown>;
}

export interface VercelApiResult {
  success: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

/**
 * Real-time budget enforcement for subagents (owner 2026-09-15:
 * "make the usage real time -- users can drain more than their
 * usage"). The HOST (apps/web) implements this against its in-memory
 * window/balance counters and injects it via call options -- the
 * framework stays vendor-agnostic about pricing and billing.
 *
 * The task tool consults it:
 *  - once before launching a subagent (planSubagent) -- can veto the
 *    launch entirely (stop) or clamp the subagent's per-step output
 *    (maxOutputTokens) so a subagent can't blow past the window;
 *  - after every subagent model step (noteSubagentStepUsage) -- the
 *    host decrements its shared budget counters and can stop the
 *    subagent mid-task, leaving the parent turn to fail the same way
 *    the main model does.
 *
 * IMPORTANT: the host must NOT write ledger rows from these calls if
 * the durable debit already happens elsewhere (apps/web debits subagent
 * usage at chat-post-finish) -- these hooks are for real-time
 * enforcement only, never for durable accounting.
 */
export interface SubagentBudgetPlan {
  stop: boolean;
  /** Which budget tripped -- mirrors the main-model metadata flags
   * (windowExhausted vs creditExhausted) for user-facing wording. */
  reason?: "window" | "credit";
  /** Per-step output clamp for the subagent (whole task, applied to
   * every internal step), or undefined for no clamp. */
  maxOutputTokens?: number;
}

export interface SubagentBudgetGuard {
  planSubagent(modelId: string): SubagentBudgetPlan;
  noteSubagentStepUsage(
    modelId: string,
    usage: LanguageModelUsage,
  ): SubagentBudgetPlan;
}

export interface AgentContext {
  /** Host-backed workspace lifecycle control (tools/sandbox.ts). */
  sandboxControl?: SandboxControlContext;
  /**
   * Optional since the agent-first rework: a turn can start before the
   * workspace finishes provisioning, so experimental_context may carry no
   * sandbox at all. Every tool resolves its connection per call and
   * recovers via sandboxLifecycleHooks.beforeCommand()'s live-state read,
   * so a missing sandbox here degrades the workspace tools -- never the
   * whole turn.
   */
  sandbox?: AgentSandboxContext;
  skills?: SkillMetadata[];
  model: LanguageModel;
  subagentModel?: LanguageModel;
  github?: GithubToolContext;
  vercel?: VercelToolContext;
  sandboxLifecycleHooks?: SandboxLifecycleHooksContext;
  billingGuard?: SubagentBudgetGuard;
}

export interface SandboxExecutionContext {
  /**
   * Optional for the same reason as AgentContext.sandbox: the parent turn
   * may have started before the workspace existed. Subagents then fail
   * their own tool calls with a clear "workspace is starting" error
   * instead of taking the parent turn down with them.
   */
  sandbox?: AgentSandboxContext;
}

export function isSandboxState(value: unknown): value is SandboxState {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "vercel"
  );
}

export const EVICTION_THRESHOLD_BYTES = 80 * 1024;
