"use client";

import { useState } from "react";
import { Expand } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface MessageAttachmentChipProps {
  url: string;
  filename?: string;
  className?: string;
}

/**
 * A compact, v0-style thumbnail chip for an image attachment already sent
 * in the conversation. Renders small inline (matching the composer's
 * pending-attachment preview size) instead of a large inline image, and
 * opens a full-size lightbox on click. Keeps the message timeline scannable
 * when a turn includes one or more image attachments.
 */
export function MessageAttachmentChip({
  url,
  filename,
  className,
}: MessageAttachmentChipProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={cn(
          "group relative h-20 w-20 flex-shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted transition-opacity hover:opacity-90",
          className,
        )}
        aria-label={`Open ${filename ?? "attached image"} full size`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- Data URLs / signed URLs aren't compatible with next/image's optimizer */}
        <img
          src={url}
          alt={filename ?? "Attached image"}
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
          <Expand className="h-4 w-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-3xl border-none bg-transparent p-0 shadow-none [&>button]:text-white">
          <DialogTitle className="sr-only">
            {filename ?? "Attached image"}
          </DialogTitle>
          {/* eslint-disable-next-line @next/next/no-img-element -- Full-size preview of an already-loaded image */}
          <img
            src={url}
            alt={filename ?? "Attached image"}
            className="max-h-[85vh] w-full rounded-lg object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

interface MessageAttachmentChipRowProps {
  children: React.ReactNode;
  align?: "start" | "end";
}

/** Wraps a row of chips for a single message, wrapping onto new lines. */
export function MessageAttachmentChipRow({
  children,
  align = "end",
}: MessageAttachmentChipRowProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap gap-1.5",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      {children}
    </div>
  );
}
