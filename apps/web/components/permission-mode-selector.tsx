"use client";

import { CheckIcon, ShieldCheck, ShieldAlert, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type PermissionMode = "ask" | "autoAccept" | "fullAccess";

interface PermissionModeSelectorProps {
  value: PermissionMode;
  onChange: (value: PermissionMode) => void;
  disabled?: boolean;
}

const LABELS: Record<PermissionMode, string> = {
  ask: "Ask",
  autoAccept: "Auto Accept",
  fullAccess: "Full Access",
};

const DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: "Approve dangerous bash commands, .env access, and every web request before they run.",
  autoAccept:
    "Skip approval for web requests only. Dangerous bash commands and .env access still need approval.",
  fullAccess:
    "Skip every approval gate entirely, including dangerous bash and .env access.",
};

const ICONS: Record<PermissionMode, typeof ShieldCheck> = {
  ask: ShieldCheck,
  autoAccept: ShieldAlert,
  fullAccess: ShieldOff,
};

const ICON_COLOR: Record<PermissionMode, string> = {
  ask: "text-muted-foreground hover:text-foreground",
  autoAccept: "text-amber-500 hover:text-amber-600",
  fullAccess: "text-red-500 hover:text-red-600",
};

const ORDER: PermissionMode[] = ["ask", "autoAccept", "fullAccess"];

/**
 * Composer toolbar control for the 3-way tool-approval permission mode.
 * Replaces the old single on/off "full access" toggle -- see
 * packages/agent/entry-agent.ts and tools/{bash,read,write,fetch}.ts for
 * what each mode actually gates.
 */
export function PermissionModeSelector({
  value,
  onChange,
  disabled = false,
}: PermissionModeSelectorProps) {
  const Icon = ICONS[value];

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-60",
                ICON_COLOR[value],
              )}
            >
              <Icon className="h-4 w-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          {LABELS[value]} &ndash; {DESCRIPTIONS[value]}
        </TooltipContent>
      </Tooltip>
      <PopoverContent className="w-64 p-1" align="end">
        {ORDER.map((mode) => {
          const ModeIcon = ICONS[mode];
          return (
            <button
              key={mode}
              type="button"
              onClick={() => onChange(mode)}
              className={cn(
                "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted",
              )}
            >
              <CheckIcon
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  value === mode ? "opacity-100" : "opacity-0",
                )}
              />
              <ModeIcon className="mt-0.5 size-3.5 shrink-0" />
              <span className="flex flex-col">
                <span className="font-medium">{LABELS[mode]}</span>
                <span className="text-xs text-muted-foreground">
                  {DESCRIPTIONS[mode]}
                </span>
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
