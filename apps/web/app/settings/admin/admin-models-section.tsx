"use client";

import { AlertTriangle, Loader2, Lock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getProviderDisplayName,
  ProviderIcon,
} from "@/components/provider-icons";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getAdminModelCatalog,
  setAdminModelDisabled,
  type AdminModelCatalogRow,
} from "@/lib/admin/actions";
import { cn } from "@/lib/utils";

function formatCostPerMillion(row: AdminModelCatalogRow): string {
  const input = row.cost?.input;
  const output = row.cost?.output;
  if (typeof input !== "number" && typeof output !== "number") {
    return "—";
  }
  const fmt = (n: number | undefined) =>
    typeof n === "number" ? `$${n.toFixed(2)}` : "—";
  return `${fmt(input)} in / ${fmt(output)} out`;
}

function formatContextWindow(contextWindow: number | undefined): string {
  if (!contextWindow) return "—";
  if (contextWindow >= 1_000_000) return `${contextWindow / 1_000_000}M`;
  if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1000)}K`;
  return String(contextWindow);
}

interface ModelRowProps {
  row: AdminModelCatalogRow;
  pending: boolean;
  onToggle: (modelId: string, disabled: boolean) => void;
}

function ModelRow({ row, pending, onToggle }: ModelRowProps) {
  const isOn = !row.hardBlocked && !row.adminDisabled;

  const statusBadge = row.hardBlocked ? (
    <Badge
      variant="outline"
      className="gap-1 border-muted-foreground/30 text-muted-foreground"
    >
      <Lock className="size-3" />
      Locked
    </Badge>
  ) : row.adminDisabled ? (
    <Badge
      variant="outline"
      className="border-destructive/30 bg-destructive/10 text-destructive"
    >
      Disabled
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
    >
      Live
    </Badge>
  );

  const row_ = (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5 transition-colors sm:flex-nowrap",
        row.adminDisabled && "bg-destructive/5",
        row.hardBlocked && "opacity-60",
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{row.name}</span>
          {statusBadge}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-mono">{row.id}</span>
          <span>{formatCostPerMillion(row)} / 1M tok</span>
          <span>{formatContextWindow(row.contextWindow)} ctx</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {pending && (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        )}
        <Switch
          checked={isOn}
          disabled={row.hardBlocked || pending}
          onCheckedChange={(checked) => onToggle(row.id, !checked)}
          aria-label={`Toggle ${row.name}`}
        />
      </div>
    </div>
  );

  if (row.hardBlocked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{row_}</TooltipTrigger>
        <TooltipContent>
          Disabled in code (billing or policy) -- needs a code change, not a
          toggle.
        </TooltipContent>
      </Tooltip>
    );
  }

  return row_;
}

/**
 * Admin-only model kill switch: every model the gateway offers, grouped
 * by provider with real brand icons, live pricing, and an instant on/off
 * toggle backed by the model_overrides DB table (see
 * lib/db/model-overrides.ts) -- flipping a switch here takes effect for
 * every user's next chat turn, no deploy required. Hard-blocked models
 * (billing issues, banned brand names) show as locked and can't be
 * toggled from here.
 */
export function AdminModelsSection() {
  const [data, setData] = useState<AdminModelCatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    getAdminModelCatalog()
      .then((rows) => {
        if (!cancelled) setData(rows);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load model catalog.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, AdminModelCatalogRow[]>();
    for (const row of data) {
      const list = map.get(row.provider) ?? [];
      list.push(row);
      map.set(row.provider, list);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  async function handleToggle(modelId: string, disabled: boolean) {
    if (!data) return;

    setPendingIds((prev) => new Set(prev).add(modelId));
    setData((prev) =>
      prev
        ? prev.map((row) =>
            row.id === modelId ? { ...row, adminDisabled: disabled } : row,
          )
        : prev,
    );

    try {
      await setAdminModelDisabled(modelId, disabled);
      toast.success(disabled ? `${modelId} disabled` : `${modelId} enabled`);
    } catch (err) {
      // revert optimistic update
      setData((prev) =>
        prev
          ? prev.map((row) =>
              row.id === modelId ? { ...row, adminDisabled: !disabled } : row,
            )
          : prev,
      );
      toast.error(
        err instanceof Error ? err.message : "Failed to update model.",
      );
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Models</CardTitle>
        <CardDescription>
          Every model on the gateway, grouped by provider. Flip a switch to
          instantly hide a model from every user -- no deploy needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        ) : data ? (
          grouped.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No models returned by the gateway.
            </p>
          ) : (
            grouped.map(([provider, rows]) => (
              <div key={provider} className="space-y-2">
                <div className="flex items-center gap-2">
                  <ProviderIcon provider={provider} className="size-4" />
                  <h3 className="text-sm font-semibold">
                    {getProviderDisplayName(provider)}
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {rows.length} model{rows.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {rows.map((row) => (
                    <ModelRow
                      key={row.id}
                      row={row}
                      pending={pendingIds.has(row.id)}
                      onToggle={handleToggle}
                    />
                  ))}
                </div>
              </div>
            ))
          )
        ) : (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading model catalog…
          </div>
        )}
      </CardContent>
    </Card>
  );
}
