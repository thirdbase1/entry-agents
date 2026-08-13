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
export interface GithubToolContext {
  hasRepo: boolean;
  repoOwner?: string;
  repoName?: string;
  commitAndPush: (input: {
    commitTitle?: string;
    commitBody?: string;
  }) => Promise<GithubCommitToolResult>;
}

export interface GithubCommitToolResult {
  committed: boolean;
  pushed: boolean;
  commitSha?: string;
  commitUrl?: string;
  error?: string;
}

export interface AgentContext {
  sandbox: AgentSandboxContext;
  skills?: SkillMetadata[];
  model: LanguageModel;
  subagentModel?: LanguageModel;
  github?: GithubToolContext;
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
