import type { SandboxState } from "@open-agents/sandbox";
import { stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import { z } from "zod";
import { addCacheControl, maybeCompactMessages } from "./context-management";
import {
  createReadFileState,
  rebuildReadFileState,
  type ReadFileState,
} from "./tools/read-state";
import {
  type SharedProviderModelId,
  createInertPlaceholderModel,
  sharedProvider,
  type ProviderOptionsByProvider,
} from "./models";
import { defaultModelLabel } from "./default-model";

import type { SkillMetadata } from "./skills/types";
import type {
  SubagentBudgetGuard,
  GithubToolContext,
  SandboxControlContext,
  SandboxLifecycleHooksContext,
  VercelToolContext,
} from "./types";
import { buildSystemPrompt } from "./system-prompt";
import {
  askUserQuestionTool,
  bashTool,
  editFileTool,
  githubCliTool,
  globTool,
  grepTool,
  readFileTool,
  sandboxControlTool,
  skillTool,
  taskTool,
  todoWriteTool,
  vercelApiTool,
  vercelCliTool,
  webFetchTool,
  webSearchTool,
  writeFileTool,
} from "./tools";

export interface AgentModelSelection {
  id: SharedProviderModelId;
  providerOptionsOverrides?: ProviderOptionsByProvider;
  /**
   * Live context_window from Entry's gateway model catalog. The agent
   * package keeps a conservative static fallback for non-web hosts/tests,
   * but the production web app passes the gateway value so new models do
   * not require a second hardcoded context-window entry here.
   */
  contextWindow?: number;
}

export type OpenAgentModelInput = SharedProviderModelId | AgentModelSelection;

export interface AgentSandboxContext {
  state: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
}

const callOptionsSchema = z.object({
  // Optional since the agent-first rework (owner 2026-09-19): the model
  // turn must be able to start -- and finish -- before the workspace is
  // provisioned. buildSystemPrompt already treats every sandbox-derived
  // field as optional, and the workspace tools resolve + self-heal their
  // connection per call, so omitting this degrades the turn's workspace
  // tools rather than the turn itself.
  sandbox: z.custom<AgentSandboxContext>().optional(),
  model: z.custom<OpenAgentModelInput>().optional(),
  subagentModel: z.custom<OpenAgentModelInput>().optional(),
  customInstructions: z.string().optional(),
  skills: z.custom<SkillMetadata[]>().optional(),
  // Permission mode for this call, threaded to every tool via
  // experimental_context.permissionMode -- see tools/bash.ts,
  // tools/read.ts, tools/write.ts, tools/fetch.ts.
  // "ask" (default): gate dangerous bash, .env reads/writes, and every
  //   web_fetch behind a manual approval click.
  // "autoAccept": skip the web_fetch gate only (it fires on every single
  //   outbound request) -- still gates dangerous bash and .env access.
  // "fullAccess": skip every approval gate entirely.
  permissionMode: z.enum(["ask", "autoAccept", "fullAccess"]).optional(),
  // Injected by apps/web (see app/workflows/chat.ts) so the
  // github_commit_and_push tool can reuse the exact same verified-commit
  // path as the manual "Commit & Push" button. Undefined in any host that
  // doesn't wire up GitHub (e.g. tests) -- the tool degrades to a clear
  // error in that case rather than throwing.
  github: z.custom<GithubToolContext>().optional(),
  // Injected by apps/web the same way `github` is -- see
  // AgentContext.vercel in ./types and app/workflows/chat.ts. Undefined
  // in any host that doesn't wire up Vercel (e.g. tests) -- the
  // vercel_cli tool degrades to a clear error in that case.
  vercel: z.custom<VercelToolContext>().optional(),
  // Injected by apps/web so the bash tool's sandbox connection can
  // persist/clear the durable active-command record used by the
  // sandbox-migration safety net. Undefined in any host that doesn't
  // wire it up (e.g. tests) -- getSandbox() just skips passing hooks.
  sandboxLifecycleHooks: z.custom<SandboxLifecycleHooksContext>().optional(),
  // Host-backed workspace lifecycle control (tools/sandbox.ts) -- lets the
  // agent provision/migrate/extend/delete this session's own sandbox
  // through the server's own code paths. Optional: non-web hosts and tests
  // simply don't offer the tool.
  sandboxControl: z.custom<SandboxControlContext>().optional(),
  // Extra tools merged on top of the built-in set for this call only
  // (e.g. tools/mcp.ts's createMcpToolSet() output). The caller owns
  // the full lifecycle -- resolving which servers to connect to,
  // connecting, and closing the connections once this call's stream
  // is fully consumed. This package deliberately stays vendor-agnostic
  // about *where* extra tools come from; it only knows how to merge
  // an already-built ToolSet in.
  extraTools: z.custom<ToolSet>().optional(),
  // Opt-in mode (user_preferences.guidedFrontendWorkflowEnabled, or a
  // single-turn trigger phrase -- see apps/web/app/workflows/chat.ts)
  // that injects the Guided Frontend Workflow section into the system
  // prompt. See system-prompt.ts's GUIDED_FRONTEND_WORKFLOW_PROMPT.
  guidedFrontendWorkflow: z.boolean().optional(),
  // Host-injected real-time budget enforcement for subagents
  // (apps/web, 2026-09-15 -- see SubagentBudgetGuard in ./types).
  // Undefined in hosts without billing (tests, local dev) -- the task
  // tool simply runs unguarded, exactly as before.
  billingGuard: z.custom<SubagentBudgetGuard>().optional(),
  // Per-call output-token cap (apps/web real-time billing, 2026-09-15:
  // "make Entry-window usage real time so users can't drain more than
  // their allowance"). apps/web computes what the user's remaining
  // window/balance can afford and passes it here; the model physically
  // cannot generate past it, so worst-case output spend fits the
  // budget. Undefined = no cap (ordinary turns).
  maxOutputTokens: z.number().int().positive().optional(),
});

export type OpenAgentCallOptions = z.infer<typeof callOptionsSchema>;

// Free-tier model -- kept working regardless of Opencode Zen billing
// status (see apps/web/lib/model-availability.ts, which currently hides
// kimi-k3/grok-4.5 from the picker for the same reason). This value is
// only ever used as the ToolLoopAgent constructor's placeholder model;
// prepareCall below always resolves the real per-request model from
// call options and overrides it before any real request is made.
// Defined in ./default-model (not here) to break an import cycle -- see
// that file's docstring.
export { defaultModelLabel };
// Inert placeholder: a real sharedProvider() call here at module scope
// would throw immediately if GATEWAY_BASE_URL/GATEWAY_API_KEY aren't set
// yet, which breaks Next.js's build-time page-data collection for any
// route that transitively imports this module (env vars are only
// guaranteed to exist at request time, not build time). See
// createInertPlaceholderModel in ./models.
export const defaultModel = createInertPlaceholderModel(defaultModelLabel);

function normalizeAgentModelSelection(
  selection: OpenAgentModelInput | undefined,
  fallbackId: SharedProviderModelId,
): AgentModelSelection {
  if (!selection) {
    return { id: fallbackId };
  }

  return typeof selection === "string" ? { id: selection } : selection;
}

const tools = {
  todo_write: todoWriteTool,
  read: readFileTool(),
  write: writeFileTool(),
  edit: editFileTool(),
  grep: grepTool(),
  glob: globTool(),
  bash: bashTool(),
  task: taskTool,
  ask_user_question: askUserQuestionTool,
  skill: skillTool,
  web_fetch: webFetchTool,
  web_search: webSearchTool,
  github_cli: githubCliTool(),
  vercel_cli: vercelCliTool(),
  vercel_api: vercelApiTool(),
  sandbox: sandboxControlTool(),
} satisfies ToolSet;

export const openAgent = new ToolLoopAgent({
  model: defaultModel,
  instructions: addCacheControl({
    instructions: buildSystemPrompt({}),
    model: defaultModel,
  }),
  tools,
  stopWhen: stepCountIs(1),
  callOptionsSchema,
  prepareStep: ({ messages, model, steps: _steps, experimental_context }) => {
    // Read-before-edit gate state (tools/read-state.ts): re-derived
    // from the message history on EVERY model step so it survives
    // refresh, resume, and workflow suspend/resume with no separate
    // storage to drift (the persisted read/edit/write outputs carry
    // contentHash; history IS the state). The same Map instance is
    // reused across steps so live in-turn updates from the tools
    // persist alongside the replay.
    const context = (experimental_context ?? {}) as {
      readFileState?: unknown;
      contextWindow?: number;
    };
    let readFileState: ReadFileState | undefined =
      context.readFileState instanceof Map ? context.readFileState : undefined;
    if (!readFileState) {
      readFileState = createReadFileState();
    }
    rebuildReadFileState(messages, readFileState);

    return {
      messages: addCacheControl({
        messages: maybeCompactMessages({
          messages,
          model,
          contextWindowOverride: context.contextWindow,
        }),
        model,
      }),
      experimental_context: {
        ...context,
        readFileState,
      },
    };
  },
  prepareCall: ({ options, ...settings }) => {
    if (!options) {
      throw new Error("Entry Agent requires call options with sandbox.");
    }

    const mainSelection = normalizeAgentModelSelection(
      options.model,
      defaultModelLabel,
    );
    const subagentSelection = options.subagentModel
      ? normalizeAgentModelSelection(options.subagentModel, defaultModelLabel)
      : undefined;

    const callModel = sharedProvider(mainSelection.id, {
      providerOptionsOverrides: mainSelection.providerOptionsOverrides,
    });
    const subagentModel = subagentSelection
      ? sharedProvider(subagentSelection.id, {
          providerOptionsOverrides: subagentSelection.providerOptionsOverrides,
        })
      : undefined;
    const customInstructions = options.customInstructions;
    const sandbox = options.sandbox;
    const skills = options.skills ?? [];

    const instructions = buildSystemPrompt({
      cwd: sandbox?.workingDirectory,
      currentBranch: sandbox?.currentBranch,
      customInstructions,
      environmentDetails: sandbox?.environmentDetails,
      skills,
      modelId: mainSelection.id,
      guidedFrontendWorkflow: options.guidedFrontendWorkflow,
    });

    return {
      ...settings,
      model: callModel,
      maxOutputTokens: options.maxOutputTokens,
      tools: addCacheControl({
        tools: options.extraTools
          ? { ...(settings.tools ?? tools), ...options.extraTools }
          : (settings.tools ?? tools),
        model: callModel,
      }),
      instructions: addCacheControl({
        instructions,
        model: callModel,
      }),
      experimental_context: {
        // Key omitted entirely when there is no workspace yet: an
        // explicitly-undefined sandbox would make `"sandbox" in context`
        // lie about readiness, and the lazy resolver in tools/utils.ts
        // already treats "absent" as the pending case.
        ...(sandbox ? { sandbox } : {}),
        skills,
        model: callModel,
        subagentModel,
        contextWindow: mainSelection.contextWindow,
        permissionMode: options.permissionMode ?? "ask",
        github: options.github,
        vercel: options.vercel,
        sandboxLifecycleHooks: options.sandboxLifecycleHooks,
        sandboxControl: options.sandboxControl,
        billingGuard: options.billingGuard,
      },
    };
  },
});

export type OpenAgent = typeof openAgent;
