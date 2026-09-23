"use client";

import {
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Pencil,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type QueuedPrompt = {
  id: string;
  displayText: string;
};

/**
 * Blur-vs-explicit-action ordering, extracted so it can be tested without a
 * DOM. The browser fires `blur` BEFORE the `click` that follows it, so a
 * plain "commit on blur" makes every Cancel press silently SAVE instead --
 * the blur handler ran first and committed before Cancel ever saw the click.
 *
 * The action buttons claim the blur (onMouseDown/onTouchStart both precede
 * blur); this rule is what honours that claim. Returns false when there is
 * nothing to commit OR when an explicit action already owns the blur.
 */
export function shouldCommitOnBlur(params: {
  editingId: string | null;
  claimedByAction: boolean;
}): boolean {
  return params.editingId !== null && !params.claimedByAction;
}

export type QueuedPromptsPanelProps<T extends QueuedPrompt> = {
  prompts: T[];
  onRemove: (id: string) => void;
  onEdit: (id: string, nextText: string) => void;
  onReorder: (nextOrder: T[]) => void;
};

function reorder<T>(list: T[], fromIndex: number, toIndex: number): T[] {
  const next = list.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Shows prompts the user queued up while a turn was still running (see the
 * drain effect next to `sendMessageWithPendingState` in
 * session-chat-content.tsx). Sits directly above the composer, same visual
 * language as PinnedTodoPanel.
 *
 * Each row supports:
 *  - click-to-edit the queued text in place (a queued prompt hasn't been
 *    sent yet, so it's still fully mutable)
 *  - drag-to-reorder via a dedicated grip handle, with a live drop-target
 *    highlight, plus up/down buttons as a touch-friendly fallback since
 *    native HTML5 drag is unreliable on mobile browsers
 *  - remove, same as before
 */
export function QueuedPromptsPanel<T extends QueuedPrompt>({
  prompts,
  onRemove,
  onEdit,
  onReorder,
}: QueuedPromptsPanelProps<T>) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Blur fires BEFORE the click that follows it, so without this the
  // blur-commit would land first and Cancel would never actually cancel --
  // every X press would silently save the draft instead of discarding it.
  // The action buttons claim the blur via onMouseDown (which precedes
  // blur), and commitEdit honours that claim.
  const claimBlurRef = useRef(false);

  // Autosize the editor to its content so a long queued prompt is fully
  // editable instead of trapped in a fixed-height scroll box.
  useEffect(() => {
    const node = editInputRef.current;
    if (!node) {
      return;
    }
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [draftText, editingId]);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  if (prompts.length === 0) {
    return null;
  }

  function startEditing(prompt: QueuedPrompt) {
    setEditingId(prompt.id);
    setDraftText(prompt.displayText);
  }

  function commitEdit() {
    const id = editingId;
    if (
      !shouldCommitOnBlur({
        editingId: id,
        claimedByAction: claimBlurRef.current,
      })
    ) {
      // Either nothing was being edited, or an explicit Save/Cancel claimed
      // this blur and is about to run its own handler. Release the claim so a
      // stale flag can never suppress a later edit's blur-commit.
      claimBlurRef.current = false;
      setEditingId(null);
      return;
    }
    claimBlurRef.current = false;
    setEditingId(null);
    if (id) {
      onEdit(id, draftText);
    }
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commitEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  }

  function moveBy(id: string, delta: number) {
    const fromIndex = prompts.findIndex((p) => p.id === id);
    if (fromIndex === -1) {
      return;
    }
    const toIndex = fromIndex + delta;
    if (toIndex < 0 || toIndex >= prompts.length) {
      return;
    }
    onReorder(reorder(prompts, fromIndex, toIndex));
  }

  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    const fromIndex = prompts.findIndex((p) => p.id === dragId);
    const toIndex = prompts.findIndex((p) => p.id === targetId);
    if (fromIndex === -1 || toIndex === -1) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    onReorder(reorder(prompts, fromIndex, toIndex));
    setDragId(null);
    setDragOverId(null);
  }

  return (
    <div className="mx-4 overflow-hidden rounded-t-xl border border-b-0 border-border/60 bg-card">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-xs font-semibold text-muted-foreground/70">
          Queued · {prompts.length}
        </span>
        <span className="text-[10px] text-muted-foreground/40">
          drag, edit, or reorder before they send
        </span>
      </div>
      <div className="max-h-40 space-y-1 overflow-y-auto border-t border-border/40 px-3 py-2">
        {prompts.map((prompt, index) => {
          const isEditing = editingId === prompt.id;
          const isDragging = dragId === prompt.id;
          const isDropTarget = dragOverId === prompt.id && dragId !== prompt.id;

          return (
            <div
              key={prompt.id}
              onDragOver={(event) => {
                if (!dragId || dragId === prompt.id) {
                  return;
                }
                event.preventDefault();
                setDragOverId(prompt.id);
              }}
              onDragLeave={() => {
                setDragOverId((current) =>
                  current === prompt.id ? null : current,
                );
              }}
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(prompt.id);
              }}
              className={cn(
                "group relative flex items-start gap-1.5 rounded-md bg-muted-foreground/5 px-1.5 py-1 transition-all",
                isDragging && "opacity-40",
                isDropTarget &&
                  "ring-2 ring-primary/50 ring-offset-1 ring-offset-card",
              )}
            >
              <button
                type="button"
                draggable={!isEditing}
                onDragStart={(event) => {
                  setDragId(prompt.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDragOverId(null);
                }}
                className="mt-0.5 shrink-0 cursor-grab touch-none rounded p-0.5 text-muted-foreground/30 transition-colors hover:bg-muted-foreground/10 hover:text-muted-foreground active:cursor-grabbing"
                aria-label="Drag to reorder"
              >
                <GripVertical className="h-3.5 w-3.5" />
              </button>

              <div className="mt-0.5 flex shrink-0 flex-col">
                <button
                  type="button"
                  onClick={() => moveBy(prompt.id, -1)}
                  disabled={index === 0}
                  className="rounded p-0.5 text-muted-foreground/30 transition-colors hover:bg-muted-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
                  aria-label="Move up"
                  title="Move up"
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => moveBy(prompt.id, 1)}
                  disabled={index === prompts.length - 1}
                  className="rounded p-0.5 text-muted-foreground/30 transition-colors hover:bg-muted-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
                  aria-label="Move down"
                  title="Move down"
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>

              <span className="mt-0.5 shrink-0 text-xs font-mono text-muted-foreground/50">
                {index + 1}
              </span>

              {isEditing ? (
                <textarea
                  ref={editInputRef}
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  onKeyDown={handleEditKeyDown}
                  onBlur={commitEdit}
                  className="max-h-40 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-sm leading-snug text-foreground outline-none placeholder:text-muted-foreground/40"
                  placeholder="Edit queued message…"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => startEditing(prompt)}
                  className="min-w-0 flex-1 truncate text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
                  title="Click to edit"
                >
                  {prompt.displayText.trim() || "(attachment only)"}
                </button>
              )}

              <div className="flex shrink-0 items-center gap-0.5">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      onMouseDown={() => {
                        claimBlurRef.current = true;
                      }}
                      onTouchStart={() => {
                        claimBlurRef.current = true;
                      }}
                      onClick={commitEdit}
                      className="rounded p-0.5 text-emerald-500/70 transition-colors hover:bg-emerald-500/10 hover:text-emerald-500"
                      aria-label="Save edit"
                      title="Save (Enter)"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onMouseDown={() => {
                        claimBlurRef.current = true;
                      }}
                      onTouchStart={() => {
                        claimBlurRef.current = true;
                      }}
                      onClick={cancelEdit}
                      className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-muted-foreground/10 hover:text-foreground"
                      aria-label="Cancel edit"
                      title="Discard changes (Esc)"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => startEditing(prompt)}
                      className="rounded p-0.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/50 hover:!text-foreground hover:bg-muted-foreground/10"
                      aria-label="Edit queued prompt"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(prompt.id)}
                      className="rounded p-0.5 text-muted-foreground/50 transition-colors hover:bg-muted-foreground/10 hover:text-foreground"
                      aria-label="Remove queued prompt"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
