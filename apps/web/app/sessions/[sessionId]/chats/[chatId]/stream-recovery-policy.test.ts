import { describe, expect, test } from "bun:test";
import type { WebAgentUIMessage } from "@/app/types";
import {
  CONTINUE_AFTER_ERROR_PROMPT,
  STREAM_RECOVERY_MIN_INTERVAL_MS,
  STREAM_RECOVERY_STALL_MS,
  getDeadTurnRetryAction,
  getStreamRecoveryDecision,
  getStreamRecoveryDelayMs,
  isChatStreamingProbeResponse,
  shouldScheduleStallRecovery,
} from "./stream-recovery-policy";

describe("getStreamRecoveryDecision", () => {
  const now = 50_000;

  test("blocks recovery while cooldown is active", () => {
    const decision = getStreamRecoveryDecision({
      now,
      lastRecoveryAt: now - STREAM_RECOVERY_MIN_INTERVAL_MS + 1,
      status: "error",
      hasAssistantRenderableContent: false,
      inFlightStartedAt: now - STREAM_RECOVERY_STALL_MS,
      isProbeInFlight: false,
    });

    expect(decision).toBe("none");
  });

  test("retries immediately when in error after cooldown", () => {
    const decision = getStreamRecoveryDecision({
      now,
      lastRecoveryAt: now - STREAM_RECOVERY_MIN_INTERVAL_MS,
      status: "error",
      hasAssistantRenderableContent: false,
      inFlightStartedAt: now - STREAM_RECOVERY_STALL_MS,
      isProbeInFlight: false,
    });

    expect(decision).toBe("retry-error");
  });

  test("does not probe unless chat is still submitted with no content", () => {
    const decision = getStreamRecoveryDecision({
      now,
      lastRecoveryAt: now - STREAM_RECOVERY_MIN_INTERVAL_MS,
      status: "streaming",
      hasAssistantRenderableContent: false,
      inFlightStartedAt: now - STREAM_RECOVERY_STALL_MS,
      isProbeInFlight: false,
    });

    expect(decision).toBe("none");
  });

  test("does not probe if assistant content is already visible", () => {
    const decision = getStreamRecoveryDecision({
      now,
      lastRecoveryAt: now - STREAM_RECOVERY_MIN_INTERVAL_MS,
      status: "submitted",
      hasAssistantRenderableContent: true,
      inFlightStartedAt: now - STREAM_RECOVERY_STALL_MS,
      isProbeInFlight: false,
    });

    expect(decision).toBe("none");
  });

  test("does not probe before the stall threshold is reached", () => {
    const decision = getStreamRecoveryDecision({
      now,
      lastRecoveryAt: now - STREAM_RECOVERY_MIN_INTERVAL_MS,
      status: "submitted",
      hasAssistantRenderableContent: false,
      inFlightStartedAt: now - STREAM_RECOVERY_STALL_MS + 1,
      isProbeInFlight: false,
    });

    expect(decision).toBe("none");
  });

  test("does not probe while another probe is in flight", () => {
    const decision = getStreamRecoveryDecision({
      now,
      lastRecoveryAt: now - STREAM_RECOVERY_MIN_INTERVAL_MS,
      status: "submitted",
      hasAssistantRenderableContent: false,
      inFlightStartedAt: now - STREAM_RECOVERY_STALL_MS,
      isProbeInFlight: true,
    });

    expect(decision).toBe("none");
  });

  test("does not probe while a submitted stream appears stalled", () => {
    const decision = getStreamRecoveryDecision({
      now,
      lastRecoveryAt: now - STREAM_RECOVERY_MIN_INTERVAL_MS,
      status: "submitted",
      hasAssistantRenderableContent: false,
      inFlightStartedAt: now - STREAM_RECOVERY_STALL_MS,
      isProbeInFlight: false,
    });

    expect(decision).toBe("none");
  });

  test("probes on visibility recovery when chat is ready", () => {
    const decision = getStreamRecoveryDecision({
      now,
      lastRecoveryAt: now - STREAM_RECOVERY_MIN_INTERVAL_MS,
      status: "ready",
      hasAssistantRenderableContent: true,
      inFlightStartedAt: null,
      isProbeInFlight: false,
      isVisibilityRecovery: true,
    });

    expect(decision).toBe("probe");
  });

  test("does not probe on visibility recovery when already probing", () => {
    const decision = getStreamRecoveryDecision({
      now,
      lastRecoveryAt: now - STREAM_RECOVERY_MIN_INTERVAL_MS,
      status: "ready",
      hasAssistantRenderableContent: true,
      inFlightStartedAt: null,
      isProbeInFlight: true,
      isVisibilityRecovery: true,
    });

    expect(decision).toBe("none");
  });

  test("does not probe ready status without visibility flag", () => {
    const decision = getStreamRecoveryDecision({
      now,
      lastRecoveryAt: now - STREAM_RECOVERY_MIN_INTERVAL_MS,
      status: "ready",
      hasAssistantRenderableContent: true,
      inFlightStartedAt: null,
      isProbeInFlight: false,
      isVisibilityRecovery: false,
    });

    expect(decision).toBe("none");
  });
});

describe("shouldScheduleStallRecovery", () => {
  test("does not schedule stall recovery during an active request", () => {
    expect(
      shouldScheduleStallRecovery({
        isChatInFlight: false,
        hasAssistantRenderableContent: false,
        isDocumentVisible: true,
      }),
    ).toBe(false);

    expect(
      shouldScheduleStallRecovery({
        isChatInFlight: true,
        hasAssistantRenderableContent: true,
        isDocumentVisible: true,
      }),
    ).toBe(false);

    expect(
      shouldScheduleStallRecovery({
        isChatInFlight: true,
        hasAssistantRenderableContent: false,
        isDocumentVisible: false,
      }),
    ).toBe(false);

    expect(
      shouldScheduleStallRecovery({
        isChatInFlight: true,
        hasAssistantRenderableContent: false,
        isDocumentVisible: true,
      }),
    ).toBe(false);
  });
});

describe("getStreamRecoveryDelayMs", () => {
  test("returns full stall delay when start time is unknown", () => {
    expect(
      getStreamRecoveryDelayMs({
        now: 30_000,
        inFlightStartedAt: null,
      }),
    ).toBe(STREAM_RECOVERY_STALL_MS);
  });

  test("returns remaining stall delay when turn is in progress", () => {
    expect(
      getStreamRecoveryDelayMs({
        now: 30_000,
        inFlightStartedAt: 27_500,
      }),
    ).toBe(1_500);
  });

  test("clamps delay to zero after stall threshold", () => {
    expect(
      getStreamRecoveryDelayMs({
        now: 30_000,
        inFlightStartedAt: 10_000,
      }),
    ).toBe(0);
  });
});

describe("isChatStreamingProbeResponse", () => {
  test("accepts valid probe payload", () => {
    expect(
      isChatStreamingProbeResponse({
        chats: [
          { id: "chat-1", isStreaming: true },
          { id: "chat-2", isStreaming: false },
        ],
      }),
    ).toBe(true);
  });

  test("rejects invalid payloads", () => {
    expect(isChatStreamingProbeResponse(null)).toBe(false);
    expect(isChatStreamingProbeResponse({})).toBe(false);
    expect(
      isChatStreamingProbeResponse({
        chats: [{ id: "chat-1", isStreaming: "yes" }],
      }),
    ).toBe(false);
  });
});

describe("getDeadTurnRetryAction (hard strategy)", () => {
  test("regenerates when the last message is a user message (no output yet)", () => {
    const action = getDeadTurnRetryAction([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ],
      "hard");
    expect(action).toBe("regenerate");
  });

  test("regenerates when the last assistant message is empty", () => {
    const action = getDeadTurnRetryAction([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "a1", role: "assistant", parts: [] },
    ],
      "hard");
    expect(action).toBe("regenerate");
  });

  test("regenerates when the last assistant message is only step-start parts", () => {
    const action = getDeadTurnRetryAction([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "a1", role: "assistant", parts: [{ type: "step-start" }] },
    ],
      "hard");
    expect(action).toBe("regenerate");
  });

  test("regenerates when the last assistant message is only the friendly error notice", () => {
    const action = getDeadTurnRetryAction([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "The AI provider is temporarily unavailable. Please try again in a moment.",
          },
        ],
      },
    ],
      "hard");
    expect(action).toBe("regenerate");
  });

  test("regenerates for a friendly error notice with the repeat-failure suffix", () => {
    const action = getDeadTurnRetryAction([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "The request took too long and timed out. Please try again. This looks like a repeating issue rather than a one-off, so retrying probably won't help -- try switching models, or let us know if it keeps happening.",
          },
        ],
      },
    ],
      "hard");
    expect(action).toBe("regenerate");
  });

  test("continues when the last assistant message has completed tool calls", () => {
    const action = getDeadTurnRetryAction([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-bash",
            toolCallId: "tc1",
            state: "output-available",
            input: { command: "ls" },
            output: {
              success: true,
              exitCode: 0,
              stdout: "file.txt",
              stderr: "",
            },
          },
        ],
      },
    ],
      "hard");
    expect(action).toBe("continue");
  });

  test("continues when the last assistant message has real partial text", () => {
    const action = getDeadTurnRetryAction([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Let me look at your project files first." },
        ],
      },
    ],
      "hard");
    expect(action).toBe("continue");
  });

  test("continues when the last assistant message has data parts", () => {
    const action = getDeadTurnRetryAction([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "data-workspace-status",
            id: "d1",
            data: { status: "setting-up", message: "Preparing workspace" },
          },
        ],
      },
    ],
      "hard");
    expect(action).toBe("continue");
  });

  test("continues when an error notice coexists with real work", () => {
    const action = getDeadTurnRetryAction([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-bash",
            toolCallId: "tc1",
            state: "output-available",
            input: { command: "ls" },
            output: {
              success: true,
              exitCode: 0,
              stdout: "file.txt",
              stderr: "",
            },
          },
          {
            type: "text",
            text: "Something went wrong while generating a response. Please try again -- if this keeps happening, try switching models.",
          },
        ],
      },
    ],
      "hard");
    expect(action).toBe("continue");
  });
});

describe("getDeadTurnRetryAction (soft strategy / auto recovery)", () => {
  const partialWorkMessages: WebAgentUIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "tc1",
          state: "output-available",
          input: { command: "ls" },
          output: { success: true, exitCode: 0, stdout: "f", stderr: "" },
        },
      ],
    },
  ];

  test("self-heals by continuing a dead turn with partial work", () => {
    expect(getDeadTurnRetryAction(partialWorkMessages, "soft")).toBe("continue");
  });

  test("does nothing when the dead turn has no partial work", () => {
    expect(
      getDeadTurnRetryAction(
        [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
          { id: "a1", role: "assistant", parts: [] },
        ],
        "soft",
      ),
    ).toBe("none");
  });

  test("does nothing when the last message is the friendly error notice", () => {
    expect(
      getDeadTurnRetryAction(
        [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
          {
            id: "a1",
            role: "assistant",
            parts: [
              {
                type: "text",
                text: "Something went wrong while generating a response. Please try again -- if this keeps happening, try switching models.",
              },
            ],
          },
        ],
        "soft",
      ),
    ).toBe("none");
  });

  test("never auto-regenerates a turn with no output at all", () => {
    expect(
      getDeadTurnRetryAction(
        [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        "soft",
      ),
    ).toBe("none");
  });
});

describe("getDeadTurnRetryAction (stacking guard)", () => {
  const messagesAfterFailedContinue: WebAgentUIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "build it" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "I have started building." }],
    },
    {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: CONTINUE_AFTER_ERROR_PROMPT }],
    },
  ];

  test("soft does not stack a second continuation prompt", () => {
    expect(
      getDeadTurnRetryAction(messagesAfterFailedContinue, "soft"),
    ).toBe("none");
  });

  test("hard resubmits the existing continuation prompt instead of stacking", () => {
    // regenerate() with a trailing user message keeps it and resubmits it
    // (verified against the AI SDK implementation), so the partial
    // assistant work below it stays in history.
    expect(
      getDeadTurnRetryAction(messagesAfterFailedContinue, "hard"),
    ).toBe("regenerate");
  });

  test("a user message that merely looks similar is not treated as the prompt", () => {
    expect(
      getDeadTurnRetryAction(
        [
          { id: "u1", role: "user", parts: [{ type: "text", text: "build it" }] },
          {
            id: "a1",
            role: "assistant",
            parts: [{ type: "text", text: "I have started building." }],
          },
          {
            id: "u2",
            role: "user",
            parts: [
              {
                type: "text",
                text: "Continue from exactly where you left off, but also add tests",
              },
            ],
          },
        ],
        "soft",
      ),
    ).toBe("none");
  });
});

describe("CONTINUE_AFTER_ERROR_PROMPT", () => {
  test("is a non-empty instruction that mentions not repeating", () => {
    expect(CONTINUE_AFTER_ERROR_PROMPT.length).toBeGreaterThan(20);
    expect(CONTINUE_AFTER_ERROR_PROMPT.toLowerCase()).toContain("repeat");
  });
});
