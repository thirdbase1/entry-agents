/**
 * EntryAgentHost — Phase 5 native runtime host (Electron main-process style).
 *
 * Architecture (proven by this file + its tests):
 *
 *   Electron Main
 *     ├── EntryAgentHost
 *     │     ├── LocalSandbox (contained, rooted at the project dir)
 *     │     ├── openAgent()   ← the REAL entry agent, untouched
 *     │     ├── outer turn loop (compensates stopWhen: stepCountIs(1))
 *     │     ├── abort/cancellation  → sandbox.stop() + agent abortSignal
 *     │     └── stream → DesktopIpcEvent adapter
 *     └── Desktop Backend (separate cloud deployment)
 *           └ holds GATEWAY_API_KEY; the host only ever sees
 *             GATEWAY_BASE_URL=<backend> + a short-lived session token
 *
 * NO Next.js, NO Vercel Workflow, NO Vercel Sandbox, NO web route handlers.
 * The agent executes locally against the user's filesystem via LocalSandbox.
 */
import { randomUUID } from "node:crypto";
import { connectSandbox } from "@open-agents/sandbox";
import type { Sandbox, SandboxState } from "@open-agents/sandbox";
import { openAgent, type OpenAgentCallOptions } from "@open-agents/agent";

/** Credentials for the Desktop Backend. Never a production secret. */
export interface DesktopBackendConfig {
  /** Base URL of the Desktop Backend's gateway-proxy endpoint, e.g. https://entry-desktop.example/v1 */
  baseURL: string;
  /** Short-lived, user-scoped session token minted by the Desktop Backend at sign-in. */
  sessionToken: string;
}

export interface EntryAgentHostOptions {
  /** The user's selected project directory. Every sandbox path is contained to it. */
  projectRoot: string;
  backend: DesktopBackendConfig;
  modelId: string;
  /** Extra roots the sandbox may touch (existing LocalSandbox option). */
  allowedRoots?: string[];
  /** Extra tools (e.g. an MCP toolset built by the host) merged for every call. */
  extraTools?: OpenAgentCallOptions["extraTools"];
  appName?: string;
  appUrl?: string;
}

/** Messages the renderer sends to main. */
export type DesktopIpcRequest =
  | { type: "send"; text: string; messageId?: string }
  | { type: "approval"; approvalId: string; approved: boolean; reason?: string }
  | { type: "stop" };

/** Events main pushes to the renderer. Serializable, no class instances. */
export type DesktopIpcEvent =
  | { type: "turn-started"; turnId: string }
  | { type: "text-delta"; turnId: string; text: string }
  | { type: "reasoning-delta"; turnId: string; text: string }
  | { type: "tool-call"; turnId: string; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; turnId: string; toolCallId: string; output: unknown }
  | { type: "tool-error"; turnId: string; toolCallId: string; errorText: string }
  | { type: "approval-request"; turnId: string; approvalId: string; toolCallId: string; toolName: string; input: unknown }
  | { type: "usage"; turnId: string; inputTokens: number; cachedInputTokens: number; outputTokens: number }
  | { type: "error"; turnId: string; message: string }
  | { type: "turn-finished"; turnId: string; finishReason: string }
  | { type: "stopped"; turnId: string };

/**
 * Maps ONE AI SDK UI message chunk to zero or more IPC events. Pure function:
 * the whole stream adapter contract is testable without a browser or Electron.
 *
 * Returns [] for chunks with no desktop-visible meaning (start/finish framing,
 * step boundaries, source parts, data parts).
 */
export function mapChunkToIpcEvents(
  chunk: Record<string, unknown>,
  turnId: string,
): DesktopIpcEvent[] {
  const type = chunk.type as string | undefined;
  switch (type) {
    case "text-delta": {
      const text = (chunk.delta ?? chunk.textDelta ?? "") as string;
      return text ? [{ type: "text-delta", turnId, text }] : [];
    }
    case "reasoning-delta": {
      const text = (chunk.delta ?? chunk.textDelta ?? "") as string;
      return text ? [{ type: "reasoning-delta", turnId, text }] : [];
    }
    case "tool-input-available": {
      return [
        {
          type: "tool-call",
          turnId,
          toolCallId: String(chunk.toolCallId),
          toolName: String(chunk.toolName),
          input: chunk.input,
        },
      ];
    }
    case "tool-output-available": {
      return [
        {
          type: "tool-result",
          turnId,
          toolCallId: String(chunk.toolCallId),
          output: chunk.output,
        },
      ];
    }
    case "tool-output-error": {
      return [
        {
          type: "tool-error",
          turnId,
          toolCallId: String(chunk.toolCallId),
          errorText: String(chunk.errorText ?? "tool failed"),
        },
      ];
    }
    case "tool-approval-request": {
      return [
        {
          type: "approval-request",
          turnId,
          approvalId: String(chunk.approvalId),
          toolCallId: String(chunk.toolCallId),
          toolName: String(chunk.toolName ?? ""),
          input: chunk.input,
        },
      ];
    }
    case "error": {
      return [
        {
          type: "error",
          turnId,
          message: String(chunk.errorText ?? "unknown error"),
        },
      ];
    }
    default:
      return [];
  }
}

/** Usage observed across a turn's steps (matches LanguageModelUsage shape). */
export interface TurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function accumulateUsage(
  current: TurnUsage,
  stepUsage: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    cachedInputTokens?: number;
  } | null | undefined,
): TurnUsage {
  if (!stepUsage) return current;
  return {
    inputTokens: current.inputTokens + (stepUsage.inputTokens ?? 0),
    cachedInputTokens:
      current.cachedInputTokens +
      (stepUsage.inputTokenDetails?.cacheReadTokens ??
        stepUsage.cachedInputTokens ??
        0),
    outputTokens: current.outputTokens + (stepUsage.outputTokens ?? 0),
  };
}

/**
 * The native host. Owns project lifecycle, the sandbox, the agent runtime,
 * approvals, cancellation and cleanup. The renderer owns none of this — it
 * only sends/receives IPC events.
 */
export class EntryAgentHost {
  private sandbox: Sandbox | null = null;
  private activeTurn: { turnId: string; abort: AbortController } | null = null;
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (d: { approved: boolean; reason?: string }) => void }
  >();
  private stopped = false;

  constructor(private readonly options: EntryAgentHostOptions) {}

  /**
   * Boots the sandbox and returns the state object the agent expects.
   * LocalSandbox only — an unknown provider type throws (registry has no
   * silent fallback), so "desktop accidentally used Vercel" is impossible.
   */
  async start(): Promise<{ sandboxState: SandboxState; workingDirectory: string }> {
    const state: SandboxState = {
      type: "local",
      rootDir: this.options.projectRoot,
    } as SandboxState;

    // connectSandbox → registry → localProvider → LocalSandbox. If "local"
    // were ever unregistered this throws UnsupportedSandboxProviderError;
    // it can never fall back to Vercel.
    this.sandbox = await connectSandbox(state, {
      allowedRoots: this.options.allowedRoots,
    });

    return { sandboxState: state, workingDirectory: this.options.projectRoot };
  }

  get sandboxInstance(): Sandbox | null {
    return this.sandbox;
  }

  /**
   * Runs one user turn end-to-end and reports events through `emit`.
   *
   * The loop exists because the real agent is configured
   * `stopWhen: stepCountIs(1)` (packages/agent/open-agent.ts): one
   * `stream()` call performs exactly ONE model step and then stops, with
   * any tool results appended to the message history. Compensating here —
   * not in packages/agent — is what the web host does too.
   */
  async send(
    text: string,
    emit: (event: DesktopIpcEvent) => void,
    history: unknown[] = [],
  ): Promise<{ messages: unknown[]; usage: TurnUsage }> {
    if (!this.sandbox) throw new Error("EntryAgentHost.start() was not called");
    if (this.stopped) throw new Error("EntryAgentHost has been stopped");

    const turnId = randomUUID();
    const abort = new AbortController();
    this.activeTurn = { turnId, abort };
    emit({ type: "turn-started", turnId });

    // --- the secure model boundary -------------------------------------
    // Phase 6 hardening: NO session token / gateway credential is placed in
    // the process environment (agent-run bash inherits this process's env).
    // The authenticated transport is passed per-call through the agent's
    // gatewayConfig seam → sharedProvider({config}) instead.
    const messages = [...history, { role: "user", content: text } as never];
    let usage: TurnUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let finishReason = "unknown";

    try {
      const { sandboxState, workingDirectory } = {
        sandboxState: { type: "local", rootDir: this.options.projectRoot } as SandboxState,
        workingDirectory: this.options.projectRoot,
      };

      for (let step = 0; step < MAX_TURN_STEPS; step++) {
        const stream = await openAgent.stream({
          messages: messages as never,
          options: {
            sandbox: { state: sandboxState, workingDirectory },
            model: {
              id: this.options.modelId,
              gatewayConfig: {
                baseURL: this.options.backend.baseURL,
                apiKey: this.options.backend.sessionToken,
              },
            },
            permissionMode: "ask",
            ...(this.options.extraTools ? { extraTools: this.options.extraTools } : {}),
          } as OpenAgentCallOptions,
          abortSignal: abort.signal,
        });

        let stepFinishReason = "unknown";
        // Approval request observed in this step's stream, if any.
        let approvalRequest: {
          approvalId: string;
          toolCallId: string;
          toolName: string;
          input: unknown;
        } | null = null;

        for await (const chunk of stream.toUIMessageStream()) {
          const c = chunk as Record<string, unknown>;
          if (c.type === "tool-approval-request") {
            approvalRequest = {
              approvalId: String(c.approvalId),
              toolCallId: String(c.toolCallId),
              toolName: String(c.toolName ?? ""),
              input: c.input,
            };
          }
          for (const event of mapChunkToIpcEvents(c, turnId)) {
            // approval-request is emitted ONCE from the gate below (after
            // waitForApproval is registered) — emitting it here races the
            // renderer's immediate respondApproval IPC against registration.
            if (event.type !== "approval-request") emit(event);
          }
          if (typeof c.type === "string" && c.type.startsWith("finish")) {
            stepFinishReason = String(c.finishReason ?? stepFinishReason);
          }
        }

        // stream.totalUsage aggregates every step (per-step UI chunks don't
        // carry usage on this AI SDK version) — authoritative per turn.
        const total = await stream.totalUsage;
        usage = accumulateUsage(usage, total as never);

        // The AI SDK's own response messages (assistant tool calls + the
        // tool-result message) are the authoritative append — hand-building
        // them from raw chunks would drop the tool results and stall the loop.
        const response = await stream.response;
        messages.push(...(response.messages as never[]));

        // Approval gate: the SDK paused with a tool-approval-request part in
        // the assistant message and did NOT execute the tool. Route the
        // decision to the renderer, then append the tool-role
        // tool-approval-response message the SDK expects on the next
        // stream() call (standardizePrompt → collectToolApprovals executes
        // approved tools / emits denied outputs from that message).
        if (approvalRequest) {
          emit({ type: "approval-request", turnId, ...approvalRequest });
          const decision = await this.waitForApproval(approvalRequest.approvalId, abort.signal);
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: approvalRequest.approvalId,
                approved: decision.approved,
                ...(decision.reason ? { reason: decision.reason } : {}),
              },
            ],
          } as never);
          // If denied, the SDK turns the response into a tool-result with
          // type "execution-denied" output — the loop continues so the
          // model sees the denial. Either way, keep looping.
          finishReason = "tool-calls";
          continue;
        }

        finishReason = stepFinishReason;

        // Continue the turn while the model is still asking for tools
        // (the web host's loop, mirrored here); stop on any terminal reason.
        if (stepFinishReason !== "tool-calls") break;
      }

      emit({ type: "usage", turnId, ...usage });
      emit({ type: "turn-finished", turnId, finishReason });
      return { messages, usage };
    } catch (error) {
      if (abort.signal.aborted) {
        emit({ type: "stopped", turnId });
      } else {
        emit({
          type: "error",
          turnId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return { messages, usage };
    } finally {
      this.activeTurn = null;
    }
  }

  /**
   * Resolves when the renderer answers this approval id (via
   * respondToApproval) or the turn is aborted. Registers the pending
   * waiter so `respondToApproval` can find it.
   */
  private waitForApproval(
    approvalId: string,
    abort: AbortSignal,
  ): Promise<{ approved: boolean; reason?: string }> {
    return new Promise((resolve, reject) => {
      const pending = {
        resolve: (d: { approved: boolean; reason?: string }) => {
          abort.removeEventListener("abort", onAbort);
          resolve(d);
        },
      };
      const onAbort = () => {
        this.pendingApprovals.delete(approvalId);
        reject(new Error("Turn aborted while awaiting approval"));
      };
      this.pendingApprovals.set(approvalId, pending);
      if (abort.aborted) {
        onAbort();
        return;
      }
      abort.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Routes a renderer approval decision to the waiter. Mirrors the web
   * client's `addToolApprovalResponse({id, approved, reason})`.
   */
  respondToApproval(
    approvalId: string,
    decision: { approved: boolean; reason?: string },
  ): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;
    this.pendingApprovals.delete(approvalId);
    pending.resolve(decision);
    return true;
  }

  /** Cancels the in-flight turn AND kills processes it started. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.activeTurn?.abort.abort();
    this.activeTurn = null;
    await this.sandbox?.stop?.();
  }
}

const MAX_TURN_STEPS = 50;
