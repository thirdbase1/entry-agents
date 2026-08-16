"use client";

import { Search } from "lucide-react";
import type { ToolRendererProps } from "@/app/lib/render-tool";
import { ToolLayout } from "../tool-layout";

export function SearchRenderer({
  part,
  state,
  onApprove,
  onDeny,
}: ToolRendererProps<"tool-web_search">) {
  const input = part.input;
  const queries = input?.queries ?? [];
  const summary =
    queries.length > 0 ? queries.join(" • ") : (input?.objective ?? "...");

  const output = part.state === "output-available" ? part.output : undefined;
  const results = output?.success === true ? output.results : undefined;
  const outputError =
    output?.success === false ? (output.error ?? "Search failed") : undefined;

  const mergedState = outputError
    ? { ...state, error: state.error ?? outputError }
    : state;

  const meta =
    results !== undefined
      ? `${results.length} result${results.length === 1 ? "" : "s"}`
      : undefined;

  const expandedContent =
    results && results.length > 0 ? (
      <div className="space-y-2.5">
        {results.map((result, i) => (
          <a
            key={`${result.url}-${i}`}
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-md border border-border/60 px-2.5 py-2 text-sm hover:bg-muted/50"
          >
            <div className="truncate font-medium text-foreground">
              {result.title || result.url}
            </div>
            <div className="truncate text-[12px] text-muted-foreground/70">
              {result.url}
            </div>
            {result.excerpts[0] && (
              <div className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">
                {result.excerpts[0]}
              </div>
            )}
          </a>
        ))}
      </div>
    ) : undefined;

  return (
    <ToolLayout
      name="Search"
      icon={<Search className="h-3.5 w-3.5" />}
      summary={summary}
      summaryClassName="font-mono"
      meta={meta}
      state={mergedState}
      expandedContent={expandedContent}
      onApprove={onApprove}
      onDeny={onDeny}
    />
  );
}
