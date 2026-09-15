import {
  estimateModelUsageCost,
  type AvailableModelCost,
} from "@/lib/models";
import type { LanguageModelUsage } from "ai";
import type { SubagentBudgetGuard } from "@open-agents/agent";

/**
 * REAL-TIME window/balance spend capping (owner 2026-09-15: "make the
 * usage for the entry plan real time so users can't drain more than
 * their usage").
 *
 * Before, the Entry-window and hard-balance gates only reacted AFTER a
 * model step finished (the finish-step handler debits, decrements the
 * in-memory counters and aborts). A step that started just under the
 * limit could overshoot it by its full input+output cost -- on a big
 * context that's a real overshoot of the $10/5h window.
 *
 * This closes the gap BEFORE the model call, in two ways:
 *  1. If even the ESTIMATED INPUT cost doesn't fit the remaining
 *     budget, block the step entirely (zero further spend) -- the turn
 *     ends with the same windowExhausted/creditExhausted flags the
 *     reactive path sets.
 *  2. Otherwise clamp the model's maxOutputTokens so the worst-case
 *     OUTPUT cost fits what's left of the budget. The residual
 *     overshoot shrinks from "one whole step" to "input-estimate error",
 *     typically a few cents.
 *
 * Deliberately conservative where estimation is uncertain: input is
 * priced with the LAST step's real cache-read ratio (accurate for the
 * next step, whose context is a superset) and grown 20% for the tool
 * results appended since. Estimation error can only overshoot by the
 * input margin -- never by unbounded output again.
 *
 * Pure policy -- bun-testable, no server-only imports.
 */

export type RealtimeSpendBlockReason = "window" | "credit" | null;

export interface RealtimeSpendCap {
  /**
   * "window" -> abort the step before it starts; the Entry window is
   * the binding budget. "credit" -> same, but the balance is binding
   * (message should say "top up", not "window refills"). null -> run
   * the step (possibly clamped).
   */
  blockReason: RealtimeSpendBlockReason;
  /**
   * maxOutputTokens clamp for the model call, or undefined when no
   * clamp is needed (budget comfortable / pricing unknown).
   */
  maxOutputTokens?: number;
}

/** Below this many affordable output tokens a step can't do useful
 * work (a single tool call's JSON args often exceed it) -- block the
 * step instead of emitting a guaranteed-truncated, still-billed one. */
const MIN_USEFUL_OUTPUT_TOKENS = 200;

/** Above this the clamp is a no-op vs. the model's own headroom -- skip
 * it so ordinary turns never see a maxOutputTokens at all. */
const CLAMP_CEILING_TOKENS = 32_768;

/** Margin kept between the clamp and the exact remaining budget, to
 * absorb float jitter and small estimation error on the output side. */
const OUTPUT_BUDGET_MARGIN = 0.98;

export function estimateNextStepInputTokens(
  lastStepUsage: LanguageModelUsage | undefined,
  /**
   * LAZY on purpose (perf, owner 2026-09-15: "make sure all these
   * checks don't make the agent response slow"): serializing the full
   * conversation costs ~5-15ms per step on large contexts, and it's
   * only needed on the FIRST step of a turn (no measured baseline
   * yet). Pass a getter, not a number -- on every later step the
   * getter is never invoked and this whole function stays O(1).
   */
  getSerializedMessagesCharCount: () => number,
): number {
  if (lastStepUsage?.inputTokens) {
    // The next step's prompt is the last one plus the tool results and
    // (occasionally) a new user message appended since -- 20% growth
    // covers typical multi-tool steps.
    return Math.ceil(lastStepUsage.inputTokens * 1.2);
  }
  // First step of a turn: no measured baseline. Rough heuristic -- 4
  // chars/token for the conversation plus a flat 8k for the system
  // prompt + tool schemas.
  return Math.ceil(getSerializedMessagesCharCount() / 4) + 8_000;
}

/**
 * Shared affordable-output math for both the main-model cap and the
 * subagent guard: given a budget in cents and a model's pricing, how
 * many output tokens fit (with the same 98% margin), or should the
 * call be blocked (< MIN_USEFUL_OUTPUT_TOKENS)? Comfortable budgets get
 * no clamp at all (CLAMP_CEILING_TOKENS).
 */
export function computeAffordableOutputTokens(
  budgetCents: number,
  cost: AvailableModelCost | undefined,
): { stop: boolean; maxOutputTokens?: number } {
  if (!cost) {
    return { stop: false };
  }
  const millionOutputCostUsd = estimateModelUsageCost(
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 },
    cost,
  );
  if (millionOutputCostUsd === undefined || millionOutputCostUsd <= 0) {
    return { stop: false };
  }
  const centsPerOutputToken = (millionOutputCostUsd * 100) / 1_000_000;
  const affordableOutputTokens = Math.floor(
    (budgetCents * OUTPUT_BUDGET_MARGIN) / centsPerOutputToken,
  );
  if (affordableOutputTokens < MIN_USEFUL_OUTPUT_TOKENS) {
    return { stop: true };
  }
  if (affordableOutputTokens >= CLAMP_CEILING_TOKENS) {
    return { stop: false };
  }
  return { stop: false, maxOutputTokens: affordableOutputTokens };
}

/**
 * Apply a spend to the in-memory window/balance budgets -- the SAME
 * mutation the main-model finish-step handler performs, extracted so
 * the subagent guard (which also spends from these budgets) can share
 * one tested code path. Pure: returns the new counters + whether the
 * spend exhausted a budget and which one.
 */
export function applySpendToBudgets(input: {
  remainingWindowBudgetCents: number | null;
  remainingBalanceCents: number;
  enforceCreditBlock: boolean;
  costCents: number;
}): {
  remainingWindowBudgetCents: number | null;
  remainingBalanceCents: number;
  exhaustedReason: "window" | "credit" | null;
} {
  const {
    remainingWindowBudgetCents,
    remainingBalanceCents,
    enforceCreditBlock,
    costCents,
  } = input;

  let windowBudget = remainingWindowBudgetCents;
  if (windowBudget !== null) {
    windowBudget -= costCents;
  }

  let balance = remainingBalanceCents;
  if (enforceCreditBlock) {
    balance -= costCents;
  }

  // Which budget binds FIRST (smallest after spend) decides the
  // wording the user sees: "window refills" vs "top up".
  const candidates: Array<{ cents: number; reason: "window" | "credit" }> = [];
  if (windowBudget !== null) {
    candidates.push({ cents: windowBudget, reason: "window" });
  }
  if (enforceCreditBlock) {
    candidates.push({ cents: balance, reason: "credit" });
  }
  const exhaustedReason =
    candidates.length > 0 &&
    Math.min(...candidates.map((c) => c.cents)) <= 0
      ? candidates.reduce((a, b) => (b.cents < a.cents ? b : a)).reason
      : null;

  return {
    remainingWindowBudgetCents: windowBudget,
    remainingBalanceCents: balance,
    exhaustedReason,
  };
}

export function computeRealtimeSpendCap(input: {
  remainingWindowBudgetCents: number | null;
  remainingBalanceCents: number;
  enforceCreditBlock: boolean;
  estimatedInputTokens: number;
  lastStepUsage: LanguageModelUsage | undefined;
  cost: AvailableModelCost | undefined;
}): RealtimeSpendCap {
  const {
    remainingWindowBudgetCents,
    remainingBalanceCents,
    enforceCreditBlock,
    estimatedInputTokens,
    lastStepUsage,
    cost,
  } = input;

  const budgets: Array<{ cents: number; reason: "window" | "credit" }> = [];
  if (
    remainingWindowBudgetCents !== null &&
    Number.isFinite(remainingWindowBudgetCents)
  ) {
    budgets.push({ cents: remainingWindowBudgetCents, reason: "window" });
  }
  if (enforceCreditBlock) {
    budgets.push({ cents: remainingBalanceCents, reason: "credit" });
  }
  if (budgets.length === 0) {
    // Non-windowed admin (balance gate exempt, no windows): nothing to
    // enforce in real time -- behave exactly as before.
    return { blockReason: null };
  }

  const binding = budgets.reduce((a, b) => (b.cents < a.cents ? b : a));

  if (!cost) {
    // Unknown pricing: can't pre-compute affordability. Keep the old
    // reactive-only enforcement rather than guessing.
    return { blockReason: null };
  }

  // Price the estimated input with the last step's real cache ratio --
  // the next prompt is a superset of the last one, so its cache-read
  // fraction should be similar.
  const lastInputTokens = lastStepUsage?.inputTokens ?? 0;
  // Cache-read lives in inputTokenDetails.cacheReadTokens on current
  // adapters (the flat cachedInputTokens field is deprecated and
  // usually 0) -- same fallback order as estimateStepCost.
  const lastCached = Math.min(
    lastStepUsage?.inputTokenDetails?.cacheReadTokens ??
      lastStepUsage?.cachedInputTokens ??
      0,
    lastInputTokens,
  );
  const cachedRatio =
    lastInputTokens > 0 ? Math.min(1, lastCached / lastInputTokens) : 0;
  const estimatedCachedTokens = Math.floor(
    Math.max(0, estimatedInputTokens) * cachedRatio,
  );

  const inputCostUsd = estimateModelUsageCost(
    {
      inputTokens: estimatedInputTokens,
      cachedInputTokens: estimatedCachedTokens,
      outputTokens: 0,
    },
    cost,
  );
  if (inputCostUsd === undefined) {
    return { blockReason: null };
  }
  const inputCostCents = Math.round(inputCostUsd * 100);

  const remainingForOutputCents = binding.cents - inputCostCents;
  if (remainingForOutputCents <= 0) {
    // Even the input alone doesn't fit -- block before spending.
    return { blockReason: binding.reason };
  }

  // Price 1M output tokens to get the per-token output price, reusing
  // the same tier resolution as real billing.
  const millionOutputCostUsd = estimateModelUsageCost(
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    },
    cost,
  );
  if (millionOutputCostUsd === undefined || millionOutputCostUsd <= 0) {
    return { blockReason: null };
  }
  const centsPerOutputToken = millionOutputCostUsd * 100 / 1_000_000;

  const affordableOutputTokens = Math.floor(
    (remainingForOutputCents * OUTPUT_BUDGET_MARGIN) / centsPerOutputToken,
  );

  if (affordableOutputTokens < MIN_USEFUL_OUTPUT_TOKENS) {
    // The step can't afford a useful response -- block it cleanly
    // instead of generating a truncated one.
    return { blockReason: binding.reason };
  }
  if (affordableOutputTokens >= CLAMP_CEILING_TOKENS) {
    // Budget comfortable: no clamp, behave exactly as before.
    return { blockReason: null };
  }

  return { blockReason: null, maxOutputTokens: affordableOutputTokens };
}

/**
 * Host-side implementation of the framework's SubagentBudgetGuard
 * (packages/agent types). Closes the last real-time gap (2026-09-15):
 * subagent usage used to hit the ledger only at chat-post-finish, so a
 * subagent could spend past an Entry window mid-task.
 *
 * The guard shares the parent turn's IN-MEMORY window/balance counters
 * via callbacks -- it never writes ledger rows itself (the durable
 * subagent debit still happens at chat-post-finish; double-billing is
 * impossible by construction).
 *
 * Pure: all billing state flows through the callbacks, so the factory
 * is fully bun-testable.
 */
export interface SubagentBudgetGuardCallbacks {
  getWindowRemainingCents(): number | null;
  getBalanceRemainingCents(): number;
  getEnforceCreditBlock(): boolean;
  /**
   * Apply a spend to the live counters (mirrors the main-model
   * finish-step mutation, including tripping the exhausted flags).
   * Returns the post-spend budget state.
   */
  spendCents(costCents: number): ReturnType<typeof applySpendToBudgets>;
  getCost(modelId: string): AvailableModelCost | undefined;
}

export function buildSubagentBudgetGuard(
  callbacks: SubagentBudgetGuardCallbacks,
): SubagentBudgetGuard {
  const bindingBudget = (): { cents: number; reason: "window" | "credit" } | null => {
    const candidates: Array<{ cents: number; reason: "window" | "credit" }> = [];
    const windowBudget = callbacks.getWindowRemainingCents();
    if (windowBudget !== null && Number.isFinite(windowBudget)) {
      candidates.push({ cents: windowBudget, reason: "window" });
    }
    if (callbacks.getEnforceCreditBlock()) {
      candidates.push({
        cents: callbacks.getBalanceRemainingCents(),
        reason: "credit",
      });
    }
    if (candidates.length === 0) {
      return null;
    }
    return candidates.reduce((a, b) => (b.cents < a.cents ? b : a));
  };

  return {
    planSubagent(modelId: string) {
      const binding = bindingBudget();
      if (!binding) {
        return { stop: false };
      }
      const affordable = computeAffordableOutputTokens(
        binding.cents,
        callbacks.getCost(modelId),
      );
      if (affordable.stop) {
        return { stop: true, reason: binding.reason };
      }
      return {
        stop: false,
        ...(affordable.maxOutputTokens !== undefined
          ? { maxOutputTokens: affordable.maxOutputTokens }
          : {}),
      };
    },

    noteSubagentStepUsage(modelId: string, usage: LanguageModelUsage) {
      if (!bindingBudget()) {
        return { stop: false };
      }
      const costUsd = estimateModelUsageCost(
        {
          inputTokens: usage.inputTokens ?? 0,
          cachedInputTokens:
            usage.inputTokenDetails?.cacheReadTokens ??
            usage.cachedInputTokens ??
            0,
          outputTokens: usage.outputTokens ?? 0,
        },
        callbacks.getCost(modelId),
      );
      if (costUsd === undefined) {
        // Unknown pricing: can't enforce in real time; the post-finish
        // debit still lands durably.
        return { stop: false };
      }
      const costCents = Math.max(0, Math.round(costUsd * 100));
      const state = callbacks.spendCents(costCents);
      if (state.exhaustedReason) {
        return { stop: true, reason: state.exhaustedReason };
      }
      return { stop: false };
    },
  };
}
