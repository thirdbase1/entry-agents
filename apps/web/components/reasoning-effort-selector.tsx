"use client";

import { CheckIcon, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type ReasoningEffort,
  REASONING_EFFORT_LEVELS,
} from "@/lib/model-reasoning";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface ReasoningEffortSelectorProps {
  value: ReasoningEffort | null;
  onChange: (value: ReasoningEffort | null) => void;
  disabled?: boolean;
}

const LABELS: Record<ReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * Compact effort picker shown next to ModelSelectorCompact, only when the
 * currently selected model actually supports a reasoning-effort override
 * (see lib/model-reasoning.ts). null means "use the model's default".
 */
export function ReasoningEffortSelector({
  value,
  onChange,
  disabled = false,
}: ReasoningEffortSelectorProps) {
  const displayLabel = value ? LABELS[value] : "Auto";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title="Reasoning effort"
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-neutral-500 transition-colors hover:bg-white/5 hover:text-neutral-300 disabled:pointer-events-none disabled:opacity-60"
        >
          <span className="max-w-[80px] truncate">{displayLabel}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1" align="start">
        <button
          type="button"
          onClick={() => onChange(null)}
          className={cn(
            "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted",
          )}
        >
          <CheckIcon
            className={cn("size-3.5 shrink-0", value ? "opacity-0" : "opacity-100")}
          />
          Auto
        </button>
        {REASONING_EFFORT_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => onChange(level)}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted",
            )}
          >
            <CheckIcon
              className={cn(
                "size-3.5 shrink-0",
                value === level ? "opacity-100" : "opacity-0",
              )}
            />
            {LABELS[level]}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
