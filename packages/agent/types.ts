import type { SandboxState } from "@open-agents/sandbox";
import type { LanguageModel } from "ai";
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
export interface SandboxLifecycleHooksContext {
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
   */
  refreshSandboxState: () => Promise<SandboxState>;
}

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

export interface AgentContext {
  sandbox: AgentSandboxContext;
  skills?: SkillMetadata[];
  model: LanguageModel;
  subagentModel?: LanguageModel;
  github?: GithubToolContext;
  vercel?: VercelToolContext;
  sandboxLifecycleHooks?: SandboxLifecycleHooksContext;
}

export interface SandboxExecutionContext {
  sandbox: AgentSandboxContext;
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
