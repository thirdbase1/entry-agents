"use client";

import type { AvailableModel } from "@/lib/models";
import {
  ProviderIcon,
  getProviderDisplayName,
  getProviderFromModelId,
} from "@/components/provider-icons";

function formatContext(tokens: number | undefined): string {
  if (!tokens) return "—";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

function formatPrice(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value === 0) return "Free";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function isFree(model: AvailableModel): boolean {
  return model.cost?.input === 0 && model.cost?.output === 0;
}

export function PricingTable({ models }: { readonly models: AvailableModel[] }) {
  const sorted = [...models].sort((a, b) => {
    const aFree = isFree(a);
    const bFree = isFree(b);
    if (aFree !== bFree) return aFree ? -1 : 1;
    const aOut = a.cost?.output ?? 0;
    const bOut = b.cost?.output ?? 0;
    return aOut - bOut;
  });

  return (
    <div className="overflow-hidden border border-(--l-border)">
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 border-b border-(--l-border) bg-(--l-fg-6) px-4 py-3 text-xs font-medium uppercase tracking-wide text-(--l-fg-3) sm:grid-cols-[2fr_1fr_1fr_1fr_1fr] sm:px-6">
        <div>Model</div>
        <div className="text-right">Context</div>
        <div className="text-right">Input</div>
        <div className="text-right">Output</div>
        <div className="hidden text-right sm:block">Cache read</div>
      </div>

      {sorted.map((model) => {
        const provider = getProviderFromModelId(model.id);
        const free = isFree(model);
        return (
          <div
            key={model.id}
            className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-4 border-b border-(--l-border) px-4 py-4 last:border-b-0 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr] sm:px-6"
          >
            <div className="flex min-w-0 items-center gap-3">
              <ProviderIcon
                provider={provider}
                className="size-5 shrink-0 opacity-90"
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium sm:text-base">
                  {model.name}
                </div>
                <div className="truncate text-xs text-(--l-fg-3)">
                  {getProviderDisplayName(provider)}
                  {free && (
                    <span className="ml-2 rounded bg-(--l-fg-6) px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-(--l-fg-2)">
                      Free
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="text-right text-sm tabular-nums text-(--l-fg-2)">
              {formatContext(model.context_window)}
            </div>
            <div className="text-right text-sm tabular-nums text-(--l-fg-2)">
              {formatPrice(model.cost?.input)}
              {!free && (
                <span className="text-(--l-fg-3)">/M</span>
              )}
            </div>
            <div className="text-right text-sm tabular-nums text-(--l-fg-2)">
              {formatPrice(model.cost?.output)}
              {!free && <span className="text-(--l-fg-3)">/M</span>}
            </div>
            <div className="hidden text-right text-sm tabular-nums text-(--l-fg-2) sm:block">
              {model.cost?.cache_read !== undefined
                ? `${formatPrice(model.cost.cache_read)}${!free ? "/M" : ""}`
                : "—"}
            </div>
          </div>
        );
      })}
    </div>
  );
}
