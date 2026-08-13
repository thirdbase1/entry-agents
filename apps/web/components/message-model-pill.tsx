"use client";

import { useState } from "react";
import type {
  WebAgentMessageMetadata,
  WebAgentStepCostBreakdown,
} from "@/app/types";
import type { ModelOption } from "@/lib/model-options";
import {
  ProviderIcon,
  getProviderFromModelId,
  stripProviderPrefix,
} from "@/components/provider-icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface MessageModelPillProps {
  metadata: WebAgentMessageMetadata;
  modelOptions: ModelOption[];
}

/**
 * Format a USD cost for compact display alongside the model name.
 * Uses 4 decimals for sub-dollar amounts (typical for a single message)
 * and 2 decimals once we cross $1.
 */
function formatCostUsd(amount: number): string {
  if (amount === 0) {
    return "$0";
  }
  if (amount >= 1) {
    return (
      "$" +
      amount.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  // Show at least one significant digit for very small costs; cap at 4 decimals.
  if (amount < 0.0001) {
    return "<$0.0001";
  }
  return (
    "$" +
    amount.toLocaleString("en-US", {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    })
  );
}

function formatTokenCount(n: number | undefined): string {
  if (!n) return "0";
  return n.toLocaleString("en-US");
}

/**
 * One row in the usage breakdown dropdown: a single model step, its tokens,
 * which tools it called, and its estimated cost.
 */
function StepBreakdownRow({
  step,
  modelOptions,
}: {
  step: WebAgentStepCostBreakdown;
  modelOptions: ModelOption[];
}) {
  const option = step.modelId
    ? modelOptions.find((o) => o.id === step.modelId)
    : undefined;
  const provider =
    option?.provider ?? getProviderFromModelId(step.modelId ?? "");
  const label = option
    ? (option.shortLabel ?? stripProviderPrefix(option.label, provider))
    : (step.modelId ?? "unknown model");

  const cachedTokens = step.usage?.inputTokenDetails?.cacheReadTokens;
  const reasoningTokens = step.usage?.outputTokenDetails?.reasoningTokens;

  return (
    <div className="flex flex-col gap-1 border-b border-border/50 py-2 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
          <span className="truncate text-xs font-medium">
            Step {step.stepNumber} · {label}
          </span>
        </div>
        {typeof step.cost === "number" && (
          <span className="shrink-0 text-xs tabular-nums font-medium text-foreground/80">
            {formatCostUsd(step.cost)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>in {formatTokenCount(step.usage?.inputTokens)}</span>
        <span>out {formatTokenCount(step.usage?.outputTokens)}</span>
        {Boolean(reasoningTokens) && (
          <span>reasoning {formatTokenCount(reasoningTokens)}</span>
        )}
        {Boolean(cachedTokens) && (
          <span>cached {formatTokenCount(cachedTokens)}</span>
        )}
      </div>
      {step.toolCallNames && step.toolCallNames.length > 0 && (
        <div className="text-[11px] text-muted-foreground/80">
          tools: {step.toolCallNames.join(", ")}
        </div>
      )}
    </div>
  );
}

/**
 * Compact pill shown on hover below an assistant message to indicate which
 * model produced the response. Clicking it opens a dropdown with the full
 * per-step breakdown of what made up the total usage cost -- every model
 * step, its tokens, which tools it called, and its individual cost.
 */
export function MessageModelPill({
  metadata,
  modelOptions,
}: MessageModelPillProps) {
  const [isOpen, setIsOpen] = useState(false);

  const {
    selectedModelId,
    modelId: resolvedModelId,
    totalMessageCost,
    totalMessageUsage,
    stepBreakdown,
  } = metadata;

  if (!selectedModelId && !resolvedModelId) {
    return null;
  }

  const selectedOption = selectedModelId
    ? modelOptions.find((o) => o.id === selectedModelId)
    : undefined;
  const resolvedOption = resolvedModelId
    ? modelOptions.find((o) => o.id === resolvedModelId)
    : undefined;

  const option = selectedOption ?? resolvedOption;
  const displayLabel =
    option?.shortLabel ?? option?.label ?? selectedModelId ?? resolvedModelId;

  if (!displayLabel) {
    return null;
  }

  const provider =
    option?.provider ??
    getProviderFromModelId(selectedModelId ?? resolvedModelId ?? "");

  const shortLabel = option
    ? (option.shortLabel ?? stripProviderPrefix(option.label, provider))
    : displayLabel;

  const hasCost =
    typeof totalMessageCost === "number" &&
    Number.isFinite(totalMessageCost) &&
    totalMessageCost >= 0;

  const hasBreakdown = Boolean(stepBreakdown && stepBreakdown.length > 0);

  const pill = (
    <span className="inline-flex max-w-[320px] items-center gap-1 rounded px-1.5 py-0.5 text-[11px] leading-tight text-muted-foreground/70 transition-colors hover:text-muted-foreground">
      <ProviderIcon provider={provider} className="size-3 shrink-0" />
      <span className="truncate">{shortLabel}</span>
      {hasCost && (
        <>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          {/* Cost is the actual info users are looking for here -- give it
              full contrast rather than fading it with the rest of the pill. */}
          <span className="tabular-nums font-medium text-foreground/80">
            {formatCostUsd(totalMessageCost as number)}
          </span>
        </>
      )}
    </span>
  );

  // No breakdown data available (older messages predating this feature, or
  // no cost info at all) -- just render the plain pill, nothing to click into.
  if (!hasBreakdown) {
    return pill;
  }

  const cachedTotal = totalMessageUsage?.inputTokenDetails?.cacheReadTokens;
  const reasoningTotal = totalMessageUsage?.outputTokenDetails?.reasoningTokens;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="cursor-pointer rounded transition-opacity hover:opacity-80"
          aria-label="Show usage breakdown"
        >
          {pill}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold">Usage breakdown</span>
          {hasCost && (
            <span className="text-xs tabular-nums font-semibold">
              {formatCostUsd(totalMessageCost as number)}
            </span>
          )}
        </div>
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>
            total in {formatTokenCount(totalMessageUsage?.inputTokens)}
          </span>
          <span>out {formatTokenCount(totalMessageUsage?.outputTokens)}</span>
          {Boolean(reasoningTotal) && (
            <span>reasoning {formatTokenCount(reasoningTotal)}</span>
          )}
          {Boolean(cachedTotal) && (
            <span>cached {formatTokenCount(cachedTotal)}</span>
          )}
        </div>
        <div className="max-h-64 overflow-y-auto">
          {stepBreakdown?.map((step, idx) => (
            <StepBreakdownRow
              key={`${step.stepNumber}-${idx}`}
              step={step}
              modelOptions={modelOptions}
            />
          ))}
        </div>
        <div className="mt-2 text-[10px] text-muted-foreground/60">
          Costs are estimated from live gateway pricing, per model step.
        </div>
      </PopoverContent>
    </Popover>
  );
}
