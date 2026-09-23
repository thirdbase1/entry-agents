import { connectSandbox, type Sandbox } from "@open-agents/sandbox";
import type { LanguageModel, ModelMessage } from "ai";
import * as path from "path";
import type { AgentContext } from "../types";

export function isAgentContext(value: unknown): value is AgentContext {
  // `model` only -- NOT `sandbox`. A turn can legitimately start with no
  // workspace yet (agent-first, see OpenAgentCallOptions.sandbox), and
  // requiring the sandbox key here would classify a perfectly valid
  // context as "not a context", losing the lifecycle hooks that let the
  // very next tool call recover once provisioning finishes.
  return typeof value === "object" && value !== null && "model" in value;
}

function workspacePendingError(toolName?: string): string {
  const toolInfo = toolName ? ` (tool: ${toolName})` : "";
  return (
    `The workspace for this session is still starting up${toolInfo}. ` +
    "Provisioning runs in the background: answer whatever you can without " +
    "the workspace, then retry this tool later in the same turn."
  );
}

/**
 * Check if a file path is within a given directory.
 * Used as a security boundary to prevent path traversal attacks.
 *
 * @param filePath - The path to check
 * @param directory - The directory that should contain the path
 * @returns true if filePath is within or equal to directory
 */
export function isPathWithinDirectory(
  filePath: string,
  directory: string,
): boolean {
  const resolvedDir = path.resolve(directory);
  const resolvedPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedDir, filePath);
  return (
    resolvedPath.startsWith(resolvedDir + path.sep) ||
    resolvedPath === resolvedDir
  );
}

/**
 * Convert a path into a compact, model-friendly display path.
 *
 * Paths inside the sandbox working directory are returned relative to that
 * directory (e.g., "src/index.ts") to avoid repeating long absolute prefixes.
 * Paths outside the working directory remain absolute for clarity and safety.
 */
export function toDisplayPath(
  filePath: string,
  workingDirectory: string,
): string {
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workingDirectory, filePath);

  if (!isPathWithinDirectory(absolutePath, workingDirectory)) {
    return absolutePath.replace(/\\/g, "/");
  }

  const relativePath = path.relative(workingDirectory, absolutePath);
  if (relativePath === "") {
    return ".";
  }

  return relativePath.replace(/\\/g, "/");
}

/**
 * Get sandbox from experimental context with null safety.
 * Throws a descriptive error if sandbox is not initialized.
 *
 * @param experimental_context - The context passed to tool execute functions
 * @param toolName - Optional tool name for better error messages
 * @returns The sandbox instance
 * @throws Error if sandbox is not available in context
 */
async function resolveSandboxForOperation(
  experimental_context: unknown,
  toolName?: string,
) {
  const context = isAgentContext(experimental_context)
    ? experimental_context
    : undefined;

  const hooks = context?.sandboxLifecycleHooks
    ? {
        onCommandStart: context.sandboxLifecycleHooks.onCommandStart,
        onCommandEnd: context.sandboxLifecycleHooks.onCommandEnd,
      }
    : undefined;

  // Agent-first turns can start before the workspace finishes
  // provisioning, so experimental_context may carry no sandbox at all.
  // Every tool resolves its connection per call anyway, so prefer the
  // host's live session state: the moment provisioning finishes, the very
  // next tool call connects to a real workspace with no extra work and no
  // retry bookkeeping from the model.
  const commandGate = context?.sandboxLifecycleHooks
    ? await context.sandboxLifecycleHooks.beforeCommand()
    : context?.sandbox
      ? { sandboxState: context.sandbox.state }
      : undefined;

  if (!commandGate) {
    // No host hooks AND no snapshot sandbox: this context predates the
    // agent-first rework, or a host wired up neither. Either way there is
    // nothing safe to connect to -- fail as a tool error, never by
    // connecting a never-provisioned state (connectSandbox would CREATE a
    // brand-new, untracked sandbox; the host rejects that case in
    // beforeCommand(), which is why the hook path is preferred first).
    throw new Error(workspacePendingError(toolName));
  }

  return {
    sandbox: await connectSandbox(
      commandGate.sandboxState,
      hooks ? { hooks } : undefined,
    ),
    commandGate,
  };
}

export async function getSandbox(
  experimental_context: unknown,
  toolName?: string,
): Promise<Sandbox> {
  const resolved = await resolveSandboxForOperation(
    experimental_context,
    toolName,
  );
  return resolved.sandbox;
}

/**
 * Command-aware sandbox resolution. Exposes whether the host had to wait
 * for a migration so the bash tool can report that control-plane event to
 * the model instead of hiding it.
 */
export async function getSandboxForCommand(experimental_context: unknown) {
  return resolveSandboxForOperation(experimental_context, "bash");
}
/**
 * Reconnect to this session's sandbox using its *current* DB state
 * rather than the point-in-time snapshot in `experimental_context`.
 * Used by the bash tool after a command comes back `killedExternally`
 * (force-killed by the sandbox-migration safety net) -- by then the
 * session may already point at a brand-new sandbox, and reusing the
 * stale context would just reconnect to the old, stopped one.
 *
 * Returns undefined (rather than throwing) when the host hasn't wired
 * up `sandboxLifecycleHooks.refreshSandboxState` (e.g. tests, or any
 * non-web host) -- callers should fall back to surfacing the original
 * killed result in that case instead of retrying blindly.
 */
export async function reconnectSandboxAfterMigration(
  experimental_context: unknown,
): Promise<Sandbox | undefined> {
  const context = isAgentContext(experimental_context)
    ? experimental_context
    : undefined;
  if (!context?.sandboxLifecycleHooks?.refreshSandboxState) {
    return undefined;
  }

  const freshState = await context.sandboxLifecycleHooks.refreshSandboxState();
  if (!freshState) {
    // No workspace yet -- nothing to reconnect to.
    return undefined;
  }
  const hooks = {
    onCommandStart: context.sandboxLifecycleHooks.onCommandStart,
    onCommandEnd: context.sandboxLifecycleHooks.onCommandEnd,
  };
  return connectSandbox(freshState, { hooks });
}

/**
 * Get sandbox + working directory from experimental_context for approval checks.
 *
 * @param experimental_context - The context passed to needsApproval functions
 * @param toolName - Optional tool name for better error messages
 */
export function getSandboxContext(
  experimental_context: unknown,
  toolName?: string,
): {
  sandbox: AgentContext["sandbox"];
  workingDirectory: string;
} {
  const context = isAgentContext(experimental_context)
    ? experimental_context
    : undefined;
  if (!context?.sandbox) {
    // Subagents are spawned from the parent's sandbox, so this only fires
    // when the workspace is not ready yet. Same contract as
    // resolveSandboxForOperation: a tool error, not a dead turn.
    throw new Error(workspacePendingError(toolName));
  }

  return {
    sandbox: context.sandbox,
    workingDirectory: context.sandbox.workingDirectory,
  };
}

/**
 * Get model from experimental context with null safety.
 * Throws a descriptive error if model is not initialized.
 */
export function getModel(
  experimental_context: unknown,
  toolName?: string,
): LanguageModel {
  const context = isAgentContext(experimental_context)
    ? experimental_context
    : undefined;
  if (!context?.model) {
    const toolInfo = toolName ? ` (tool: ${toolName})` : "";
    const contextInfo = context
      ? `Context exists but model is missing. Context keys: ${Object.keys(context).join(", ")}`
      : "Context is undefined or null";
    throw new Error(
      `Model not initialized in context${toolInfo}. ${contextInfo}. ` +
        "Ensure the agent's prepareCall sets experimental_context: { model, ... }",
    );
  }
  return context.model;
}

/**
 * Get subagent model from experimental context, falling back to the main model.
 * Returns the dedicated subagent model if configured, otherwise the main agent model.
 */
export function getSubagentModel(
  experimental_context: unknown,
  toolName?: string,
): LanguageModel {
  const context = isAgentContext(experimental_context)
    ? experimental_context
    : undefined;
  if (!context?.model) {
    const toolInfo = toolName ? ` (tool: ${toolName})` : "";
    throw new Error(
      `Model not initialized in context${toolInfo}. ` +
        "Ensure the agent's prepareCall sets experimental_context: { model, ... }",
    );
  }
  return context.subagentModel ?? context.model;
}

/**
 * Escape a string for safe use in a single-quoted shell argument.
 * Wraps the string in single quotes and escapes any embedded single quotes.
 */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export type ToolNeedsApprovalFunction<INPUT> = (
  input: INPUT,
  options: {
    /**
     * The ID of the tool call. You can use it e.g. when sending tool-call related information with stream data.
     */
    toolCallId: string;

    /**
     * Messages that were sent to the language model to initiate the response that contained the tool call.
     * The messages **do not** include the system prompt nor the assistant response that contained the tool call.
     */
    messages: ModelMessage[];

    /**
     * Additional context.
     *
     * Experimental (can break in patch releases).
     */
    experimental_context?: unknown;
  },
) => boolean | PromiseLike<boolean>;
