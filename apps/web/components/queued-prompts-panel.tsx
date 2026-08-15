"use client";

import { X } from "lucide-react";

export type QueuedPrompt = {
  id: string;
  displayText: string;
};

export type QueuedPromptsPanelProps = {
  prompts: QueuedPrompt[];
  onRemove: (id: string) => void;
};

/**
 * Shows prompts the user queued up while a turn was still running (see the
 * drain effect next to `sendMessageWithPendingState` in
 * session-chat-content.tsx). Sits directly above the composer, same visual
 * language as PinnedTodoPanel -- each entry can be pulled back out of the
 * queue before its turn comes up.
 */
export function QueuedPromptsPanel({
  prompts,
  onRemove,
}: QueuedPromptsPanelProps) {
  if (prompts.length === 0) {
    return null;
  }

  return (
    <div className="mx-4 overflow-hidden rounded-t-xl border border-b-0 border-border/60 bg-card">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-xs font-semibold text-muted-foreground/70">
          Queued · {prompts.length}
        </span>
      </div>
      <div className="max-h-32 space-y-1 overflow-y-auto border-t border-border/40 px-3 py-2">
        {prompts.map((prompt, index) => (
          <div
            key={prompt.id}
            className="flex items-center gap-2 rounded-md bg-muted-foreground/5 px-2 py-1"
          >
            <span className="shrink-0 text-xs font-mono text-muted-foreground/50">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {prompt.displayText.trim() || "(attachment only)"}
            </span>
            <button
              type="button"
              onClick={() => onRemove(prompt.id)}
              className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-muted-foreground/10 hover:text-foreground"
              aria-label="Remove queued prompt"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
