import type { SandboxState } from "@entry/sandbox";
import { stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import { z } from "zod";
import { addCacheControl } from "./context-management";
import {
  type SharedProviderModelId,
  createInertPlaceholderModel,
  sharedProvider,
  type ProviderOptionsByProvider,
} from "./models";

import type { SkillMetadata } from "./skills/types";
import type { GithubToolContext } from "./types";
import { buildSystemPrompt } from "./system-prompt";
import {
  askUserQuestionTool,
  bashTool,
  editFileTool,
  githubCommitTool,
  globTool,
  grepTool,
  readFileTool,
  skillTool,
  taskTool,
  todoWriteTool,
  webFetchTool,
  webSearchTool,
  writeFileTool,
} from "./tools";

export interface AgentModelSelection {
  id: SharedProviderModelId;
  providerOptionsOverrides?: ProviderOptionsByProvider;
}

export type EntryModelInput = SharedProviderModelId | AgentModelSelection;

export interface AgentSandboxContext {
  state: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
}

const callOptionsSchema = z.object({
  sandbox: z.custom<AgentSandboxContext>(),
  model: z.custom<EntryModelInput>().optional(),
  subagentModel: z.custom<EntryModelInput>().optional(),
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
});

export type EntryCallOptions = z.infer<typeof callOptionsSchema>;

// Free-tier model -- kept working regardless of Opencode Zen billing
// status (see apps/web/lib/model-availability.ts, which currently hides
// kimi-k3/grok-4.5 from the picker for the same reason). This value is
// only ever used as the ToolLoopAgent constructor's placeholder model;
// prepareCall below always resolves the real per-request model from
// call options and overrides it before any real request is made.
export const defaultModelLabel = "deepseek-v4-flash" as const;
// Inert placeholder: a real sharedProvider() call here at module scope
// would throw immediately if GATEWAY_BASE_URL/GATEWAY_API_KEY aren't set
// yet, which breaks Next.js's build-time page-data collection for any
// route that transitively imports this module (env vars are only
// guaranteed to exist at request time, not build time). See
// createInertPlaceholderModel in ./models.
export const defaultModel = createInertPlaceholderModel(defaultModelLabel);

function normalizeAgentModelSelection(
  selection: EntryModelInput | undefined,
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
  github_commit_and_push: githubCommitTool(),
} satisfies ToolSet;

export const openAgent = new ToolLoopAgent({
  model: defaultModel,
  instructions: buildSystemPrompt({}),
  tools,
  stopWhen: stepCountIs(1),
  callOptionsSchema,
  prepareStep: ({ messages, model, steps: _steps }) => {
    return {
      messages: addCacheControl({
        messages,
        model,
      }),
    };
  },
  prepareCall: ({ options, ...settings }) => {
    if (!options) {
      throw new Error("Entry requires call options with sandbox.");
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
      cwd: sandbox.workingDirectory,
      currentBranch: sandbox.currentBranch,
      customInstructions,
      environmentDetails: sandbox.environmentDetails,
      skills,
      modelId: mainSelection.id,
    });

    return {
      ...settings,
      model: callModel,
      tools: addCacheControl({
        tools: settings.tools ?? tools,
        model: callModel,
      }),
      instructions,
      experimental_context: {
        sandbox,
        skills,
        model: callModel,
        subagentModel,
        permissionMode: options.permissionMode ?? "ask",
        github: options.github,
      },
    };
  },
});

export type Entry = typeof openAgent;
