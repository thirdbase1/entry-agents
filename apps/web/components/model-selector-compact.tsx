"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDown, Lock, Sparkles } from "lucide-react";
import { type ModelOption, groupByProvider } from "@/lib/model-options";
import { APP_DEFAULT_MODEL_ID } from "@/lib/models";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ProviderIcon,
  getProviderDisplayName,
} from "@/components/provider-icons";

interface ModelSelectorCompactProps {
  value: string;
  modelOptions: ModelOption[];
  onChange: (modelId: string) => void;
  disabled?: boolean;
  onCloseAutoFocus?: () => void;
  /** True when the signed-in user is on the Free plan (Luna-only access)
   * -- every model other than `freePlanModelId` renders locked with an
   * upgrade prompt instead of being selectable. Omit/false for every
   * other plan, where the picker behaves exactly as before. */
  isFreeTierLocked?: boolean;
  /** The one model ID Free-tier users can still pick (Luna) -- required
   * when isFreeTierLocked is true so that model doesn't render locked. */
  freePlanModelId?: string;
  /** Called when a Free-tier user clicks "Upgrade" inside the locked-
   * model popup -- typically routes to /billing/plans. */
  onUpgradeRequired?: () => void;
}

export function ModelSelectorCompact({
  value,
  modelOptions,
  onChange,
  disabled = false,
  onCloseAutoFocus,
  isFreeTierLocked = false,
  freePlanModelId,
  onUpgradeRequired,
}: ModelSelectorCompactProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [lockedModel, setLockedModel] = useState<ModelOption | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const focusSearchInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.select();
    });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    focusSearchInput();
  }, [focusSearchInput, open]);

  useEffect(() => {
    if (disabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const isModelShortcut =
        event.metaKey &&
        event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.code === "Slash";

      if (!isModelShortcut || event.repeat) {
        return;
      }

      event.preventDefault();
      setSearch("");
      setOpen(true);
      focusSearchInput();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, focusSearchInput]);

  const handleSelect = (modelId: string) => {
    onChange(modelId);
    setSearch("");
    setOpen(false);
  };

  const selectedOption = modelOptions.find((option) => option.id === value);
  const displayText = selectedOption?.shortLabel ?? value;

  const groups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setSearch("");
          }
        }}
      >
        <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Change model"
          aria-keyshortcuts="Meta+Alt+/"
          title="Change model (⌘⌥/)"
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-neutral-500 transition-colors hover:bg-white/5 hover:text-neutral-300 disabled:pointer-events-none disabled:opacity-60"
        >
          {selectedOption && (
            <ProviderIcon
              provider={selectedOption.provider}
              className="size-3.5 shrink-0"
            />
          )}
          <span className="max-w-[140px] truncate">{displayText}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-0"
        align="start"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusSearchInput();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus?.();
        }}
      >
        <Command>
          <CommandInput
            ref={searchInputRef}
            value={search}
            onValueChange={setSearch}
            placeholder="Search models..."
          />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.provider}
                heading={getProviderDisplayName(group.provider)}
              >
                {group.options.map((option) => {
                  const isLocked =
                    isFreeTierLocked && option.id !== freePlanModelId;
                  return (
                    <CommandItem
                      key={option.id}
                      value={`${option.label} ${option.id}`}
                      onSelect={() => {
                        if (isLocked) {
                          setOpen(false);
                          setSearch("");
                          setLockedModel(option);
                          return;
                        }
                        handleSelect(option.id);
                      }}
                      className={cn(
                        "flex items-center",
                        isLocked && "opacity-60",
                      )}
                    >
                      <ProviderIcon
                        provider={option.provider}
                        className="mr-1.5 size-3.5 shrink-0 opacity-70"
                      />
                      <span className="min-w-0 truncate">
                        {option.shortLabel}
                      </span>
                      {isLocked ? (
                        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          <Lock className="size-3" />
                          Upgrade
                        </span>
                      ) : (
                        <>
                          {option.id === APP_DEFAULT_MODEL_ID && (
                            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                              default
                            </span>
                          )}
                          <CheckIcon
                            className={cn(
                              "ml-auto size-4 shrink-0",
                              value === option.id ? "opacity-100" : "opacity-0",
                            )}
                          />
                        </>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
      </Popover>
      <Dialog
        open={lockedModel !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setLockedModel(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <div className="mb-1 flex size-9 items-center justify-center rounded-full bg-primary/10">
              <Sparkles className="size-4.5 text-primary" />
            </div>
            <DialogTitle>
              {lockedModel?.shortLabel ?? "This model"} is a paid model
            </DialogTitle>
            <DialogDescription>
              Your Free plan only includes GPT-5.6 Luna. Upgrade to Plus,
              Pro, or Max to unlock every model, including{" "}
              {lockedModel?.shortLabel ?? "this one"}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-end">
            <Button variant="ghost" onClick={() => setLockedModel(null)}>
              Maybe later
            </Button>
            <Button
              onClick={() => {
                setLockedModel(null);
                onUpgradeRequired?.();
              }}
            >
              Upgrade
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
