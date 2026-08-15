"use client";

import { CheckIcon, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReasoningEffortLevel } from "@/lib/model-reasoning";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface ReasoningEffortSelectorProps {
  value: string | null;
  /**
   * The actual levels this specific model accepts (value + label pairs),
   * from lib/model-reasoning.ts's getReasoningEffortLevels(modelId). Not
   * a fixed low/medium/high -- some models have a different real
   * vocabulary (e.g. qwen3.8-max-free's low/medium/xhigh), and this
   * component renders exactly what's passed in rather than assuming.
   */
  levels: ReasoningEffortLevel[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

/**
 * Compact effort picker shown next to ModelSelectorCompact, only when the
 * currently selected model actually supports a reasoning-effort override
 * (see lib/model-reasoning.ts). null means "use the model's default".
 */
export function ReasoningEffortSelector({
  value,
  levels,
  onChange,
  disabled = false,
}: ReasoningEffortSelectorProps) {
  const selected = value ? levels.find((level) => level.value === value) : undefined;
  const displayLabel = selected ? selected.label : "Auto";

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
        {levels.map((level) => (
          <button
            key={level.value}
            type="button"
            onClick={() => onChange(level.value)}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted",
            )}
          >
            <CheckIcon
              className={cn(
                "size-3.5 shrink-0",
                value === level.value ? "opacity-100" : "opacity-0",
              )}
            />
            {level.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
