import type { SandboxState } from "@open-agents/sandbox";
import { stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import { z } from "zod";
import { addCacheControl, maybeCompactMessages } from "./context-management";
import {
  type SharedProviderModelId,
  createInertPlaceholderModel,
  sharedProvider,
  type ProviderOptionsByProvider,
} from "./models";
import { defaultModelLabel } from "./default-model";

import type { SkillMetadata } from "./skills/types";
import type {
  GithubToolContext,
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
  skillTool,
  taskTool,
  parallelTaskTool,
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
}

export type OpenAgentModelInput = SharedProviderModelId | AgentModelSelection;

export interface AgentSandboxContext {
  state: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
}

const callOptionsSchema = z.object({
  sandbox: z.custom<AgentSandboxContext>(),
  model: z.custom<OpenAgentModelInput>().optional(),
  subagentModel: z.custom<OpenAgentModelInput>().optional(),
  customInstructions: z.string().optional(),
  skills: z.custom<SkillMetadata[]>().optional(),
  permissionMode: z.enum(["ask", "autoAccept", "fullAccess"]).optional(),
  github: z.custom<GithubToolContext>().optional(),
  vercel: z.custom<VercelToolContext>().optional(),
  sandboxLifecycleHooks: z.custom<SandboxLifecycleHooksContext>().optional(),
  extraTools: z.custom<ToolSet>().optional(),
  guidedFrontendWorkflow: z.boolean().optional(),
});

export type OpenAgentCallOptions = z.infer<typeof callOptionsSchema>;

export { defaultModelLabel };
export const defaultModel = createInertPlaceholderModel(defaultModelLabel);

function normalizeAgentModelSelection(
  selection: OpenAgentModelInput | undefined,
  fallbackId: SharedProviderModelId,
): AgentModelSelection {
  if (!selection) return { id: fallbackId };
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
  parallel_task: parallelTaskTool,
  ask_user_question: askUserQuestionTool,
  skill: skillTool,
  web_fetch: webFetchTool,
  web_search: webSearchTool,
  github_cli: githubCliTool(),
  vercel_cli: vercelCliTool(),
  vercel_api: vercelApiTool(),
} satisfies ToolSet;

export const openAgent = new ToolLoopAgent({
  model: defaultModel,
  instructions: addCacheControl({ instructions: buildSystemPrompt({}), model: defaultModel }),
  tools,
  stopWhen: stepCountIs(1),
  callOptionsSchema,
  prepareStep: ({ messages, model }) => ({
    messages: addCacheControl({ messages: maybeCompactMessages({ messages, model }), model }),
  }),
  prepareCall: ({ options, ...settings }) => {
    if (!options) throw new Error("Entry Agent requires call options with sandbox.");

    const mainSelection = normalizeAgentModelSelection(options.model, defaultModelLabel);
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
    const sandbox = options.sandbox;
    const skills = options.skills ?? [];
    const instructions = buildSystemPrompt({
      cwd: sandbox.workingDirectory,
      currentBranch: sandbox.currentBranch,
      customInstructions: options.customInstructions,
      environmentDetails: sandbox.environmentDetails,
      skills,
      modelId: mainSelection.id,
      guidedFrontendWorkflow: options.guidedFrontendWorkflow,
    });

    return {
      ...settings,
      model: callModel,
      tools: addCacheControl({
        tools: options.extraTools
          ? { ...(settings.tools ?? tools), ...options.extraTools }
          : (settings.tools ?? tools),
        model: callModel,
      }),
      instructions: addCacheControl({ instructions, model: callModel }),
      experimental_context: {
        sandbox,
        skills,
        model: callModel,
        subagentModel,
        permissionMode: options.permissionMode ?? "ask",
        github: options.github,
        vercel: options.vercel,
        sandboxLifecycleHooks: options.sandboxLifecycleHooks,
      },
    };
  },
});

export type OpenAgent = typeof openAgent;
