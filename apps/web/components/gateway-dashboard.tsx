"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircuitBoard,
  Clock,
  DollarSign,
  Loader2,
  RefreshCw,
  Server,
  TrendingUp,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

interface HealthResponse {
  status: string;
  version: string;
  gitCommit: string | null;
  uptime: number;
  routes: number;
  models: string[];
  circuitBreakers: Record<string, string>;
  metrics: {
    counters: Record<string, number | Record<string, number>>;
    gauges: Record<string, number>;
    histograms: Record<string, Record<string, number>>;
  };
}

interface MetricsResponse {
  counters: Record<string, number | Record<string, number>>;
  gauges: Record<string, number>;
  histograms: Record<string, Record<string, number>>;
}

interface ModelInfo {
  id: string;
  object: string;
  name: string;
  owned_by: string;
  protocols: string[];
}

interface RouteInfo {
  id: string;
  protocol: string;
  provider?: string;
  upstreamBaseURL: string;
  upstreamModel: string;
  upstreamApiKeyEnv?: string;
  priority: number;
  enabled: boolean;
  source: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (mins > 0 || hours > 0 || days > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatLatency(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function cnStatus(status: string): string {
  if (!status) return "";
  if (status === "closed") return "text-emerald-400";
  if (status === "half_open") return "text-amber-400";
  if (status === "open") return "text-red-400";
  return "text-muted-foreground";
}

// ─── Stat Card ──────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sublabel,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  sublabel?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p
            className={cn(
              "mt-2 text-2xl font-semibold tracking-tight",
              accent ? "text-[#ff8a3d]" : "text-foreground",
            )}
          >
            {value}
          </p>
          {sublabel && (
            <p className="mt-0.5 text-xs text-muted-foreground">{sublabel}</p>
          )}
        </div>
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg border",
            accent ? "border-[#ff8a3d]/20 bg-[#ff8a3d]/5" : "border-border",
          )}
        >
          <Icon
            className={cn(
              "size-4",
              accent ? "text-[#ff8a3d]" : "text-muted-foreground",
            )}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Latency Chart ───────────────────────────────────────────────────────────

function LatencyChart({
  histogram,
}: {
  histogram?: Record<string, number>;
}) {
  if (!histogram || !histogram.count) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
        No latency data yet
      </div>
    );
  }

  const segments = [
    { label: "p50", value: histogram.p50 || 0, color: "#ff8a3d" },
    { label: "p95", value: histogram.p95 || 0, color: "#e07c2a" },
    { label: "p99", value: histogram.p99 || 0, color: "#c46d24" },
  ];
  const max = Math.max(...segments.map((s) => s.value), 1);

  return (
    <div className="space-y-3">
      {segments.map((seg) => (
        <div key={seg.label} className="flex items-center gap-3">
          <span className="w-10 shrink-0 text-xs font-medium text-muted-foreground">
            {seg.label}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${(seg.value / max) * 100}%`,
                backgroundColor: seg.color,
              }}
            />
          </div>
          <span className="w-16 shrink-0 text-right text-xs font-medium text-foreground">
            {formatLatency(seg.value)}
          </span>
        </div>
      ))}
      <div className="flex items-center gap-4 border-t pt-3 text-xs text-muted-foreground">
        <span>min: {formatLatency(histogram.min || 0)}</span>
        <span>max: {formatLatency(histogram.max || 0)}</span>
        <span>count: {histogram.count}</span>
      </div>
    </div>
  );
}

// ─── Request Status Breakdown ────────────────────────────────────────────────

function StatusBreakdown({
  byLabel,
}: {
  byLabel?: Record<string, number>;
}) {
  if (!byLabel || Object.keys(byLabel).length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No request data yet
      </div>
    );
  }

  const entries = Object.entries(byLabel).map(([label, count]) => {
    const parsed = JSON.parse(label);
    return {
      method: parsed.method || "GET",
      status: parsed.status || 0,
      count,
    };
  });

  entries.sort((a, b) => b.count - a.count);

  const total = entries.reduce((sum, e) => sum + e.count, 0);

  return (
    <div className="space-y-2">
      {entries.map((entry) => {
        const pct = (entry.count / total) * 100;
        const is2xx = entry.status >= 200 && entry.status < 300;
        const is4xx = entry.status >= 400 && entry.status < 500;
        const is5xx = entry.status >= 500;

        return (
          <div
            key={`${entry.method}-${entry.status}`}
            className="flex items-center gap-3"
          >
            <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">
              {entry.method}
            </span>
            <span
              className={cn(
                "w-10 shrink-0 font-mono text-xs font-medium",
                is2xx && "text-emerald-400",
                is4xx && "text-amber-400",
                is5xx && "text-red-400",
              )}
            >
              {entry.status}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full",
                  is2xx && "bg-emerald-500/70",
                  is4xx && "bg-amber-500/70",
                  is5xx && "bg-red-500/70",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right text-xs font-medium text-foreground">
              {entry.count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function GatewayDashboard() {
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(
    async (url: string, key: string) => {
      const headers: Record<string, string> = {};
      if (key) headers["Authorization"] = `Bearer ${key}`;

      try {
        const [healthRes, metricsRes, modelsRes, routesRes] =
          await Promise.all([
            fetch(`${url}/health`, { headers }),
            fetch(`${url}/metrics`, { headers }),
            fetch(`${url}/v1/models`, { headers }),
            fetch(`${url}/v1/debug/routes`, { headers }),
          ]);

        if (!healthRes.ok) {
          throw new Error(`Gateway returned ${healthRes.status}`);
        }

        const healthData = await healthRes.json();
        const metricsData = metricsRes.ok ? await metricsRes.json() : null;
        const modelsData = modelsRes.ok ? await modelsRes.json() : null;
        const routesData = routesRes.ok ? await routesRes.json() : null;

        setHealth(healthData);
        setMetrics(metricsData);
        setModels(modelsData?.data || []);
        setRoutes(routesData?.routes || []);
        setError(null);
        setLastRefresh(new Date());
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to connect to gateway";
        setError(message);
        setConnected(false);
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    },
    [],
  );

  const handleConnect = async () => {
    if (!gatewayUrl.trim()) return;
    const url = gatewayUrl.trim().replace(/\/+$/, "");
    setConnecting(true);
    setError(null);
    await fetchData(url, apiKey.trim());
    setConnecting(false);
    setConnected(true);

    // Auto-refresh every 5 seconds
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => fetchData(url, apiKey.trim()), 5000);
  };

  const handleRefresh = async () => {
    if (gatewayUrl.trim()) {
      const url = gatewayUrl.trim().replace(/\/+$/, "");
      await fetchData(url, apiKey.trim());
    }
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const counters = metrics?.counters || health?.metrics?.counters || {};
  const gauges = metrics?.gauges || health?.metrics?.gauges || {};
  const histograms = metrics?.histograms || health?.metrics?.histograms || {};
  const latencyMs = histograms.request_latency_ms;
  const asCount = (value: number | Record<string, number> | undefined): number =>
    typeof value === "number" ? value : 0;
  const requestTotal = asCount(counters.request_total);
  const tokensTotal = asCount(counters.tokens_total);
  const spendTotal = asCount(counters.estimated_spend_total);
  const upstreamErrors = asCount(counters.upstream_errors);
  const fallbackTotal = asCount(counters.fallback_total);
  const rateLimitRejected = asCount(counters.rate_limit_rejected);
  const activeRequests = gauges.active_requests || 0;
  const activeStreams = gauges.active_streams || 0;
  const statusByLabel =
    (counters.request_total_by_label as Record<string, number>) || {};

  return (
    <div className="space-y-6">
      {/* ─── Connection Bar ─── */}
      <Card className="overflow-hidden">
        <CardContent className="pt-0">
          <div className="flex flex-col gap-4 py-6 lg:flex-row lg:items-end">
            <div className="flex-1 space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Gateway URL
              </label>
              <Input
                type="url"
                placeholder="https://your-gateway.example.com"
                value={gatewayUrl}
                onChange={(e) => setGatewayUrl(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex-1 space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Admin API Key
              </label>
              <Input
                type="password"
                placeholder="gw_live_..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={handleConnect}
                disabled={connecting || !gatewayUrl.trim()}
                className="bg-[#ff8a3d] text-black hover:bg-[#ff8a3d]/90"
              >
                {connecting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Zap className="size-4" />
                )}
                {connected ? "Reconnect" : "Connect"}
              </Button>
              {connected && (
                <Button
                  onClick={handleRefresh}
                  variant="outline"
                  size="icon"
                >
                  <RefreshCw className="size-4" />
                </Button>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
              <AlertTriangle className="size-4 shrink-0 text-red-400" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {connected && health && (
            <div className="flex items-center gap-3 border-t pt-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-emerald-400" />
                <span className="font-medium text-emerald-400">Connected</span>
              </div>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">v{health.version}</span>
              <span className="text-muted-foreground">·</span>
              <span className="font-mono text-xs text-muted-foreground">
                {lastRefresh
                  ? lastRefresh.toLocaleTimeString()
                  : "—"}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {!connected && !connecting && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20 text-center">
          <Server className="size-12 text-muted-foreground/40" />
          <p className="mt-4 text-lg font-medium text-muted-foreground">
            Enter your gateway URL to connect
          </p>
          <p className="mt-1 text-sm text-muted-foreground/60">
            Polls health, metrics, routes, and models every 5 seconds
          </p>
        </div>
      )}

      {connected && health && (
        <>
          {/* ─── Stat Cards ─── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total Requests"
              value={formatNumber(requestTotal)}
              sublabel={`${activeRequests} active`}
              icon={Activity}
            />
            <StatCard
              label="Avg Latency"
              value={latencyMs ? formatLatency(latencyMs.p50 || 0) : "—"}
              sublabel={latencyMs ? `p95: ${formatLatency(latencyMs.p95 || 0)}` : undefined}
              icon={Clock}
            />
            <StatCard
              label="Total Tokens"
              value={formatNumber(tokensTotal)}
              sublabel={`${activeStreams} active streams`}
              icon={TrendingUp}
            />
            <StatCard
              label="Est. Spend"
              value={`$${spendTotal.toFixed(4)}`}
              sublabel={`${upstreamErrors} upstream errors`}
              icon={DollarSign}
              accent
            />
          </div>

          {/* ─── Latency + Status ─── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Clock className="size-4 text-[#ff8a3d]" />
                  Latency Distribution
                </CardTitle>
              </CardHeader>
              <CardContent>
                <LatencyChart histogram={latencyMs} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="size-4 text-[#ff8a3d]" />
                  Request Status
                </CardTitle>
              </CardHeader>
              <CardContent>
                <StatusBreakdown byLabel={statusByLabel} />
              </CardContent>
            </Card>
          </div>

          {/* ─── Circuit Breakers ─── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CircuitBoard className="size-4 text-[#ff8a3d]" />
                Circuit Breakers
              </CardTitle>
            </CardHeader>
            <CardContent>
              {Object.keys(health.circuitBreakers || {}).length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="size-4 text-emerald-400" />
                  No circuit breakers tripped
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {Object.entries(health.circuitBreakers).map(
                    ([name, state]) => (
                      <div
                        key={name}
                        className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2"
                      >
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {name}
                        </span>
                        <span
                          className={cn(
                            "font-mono text-xs font-medium",
                            cnStatus(state),
                          )}
                        >
                          {state}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ─── Routes Table ─── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="size-4 text-[#ff8a3d]" />
                Model Routes
                <span className="ml-auto rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
                  {routes.length} route{routes.length !== 1 ? "s" : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {routes.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No routes configured
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Protocol</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {routes.map((route) => (
                      <TableRow key={route.id}>
                        <TableCell className="font-mono text-xs">
                          {route.id}
                        </TableCell>
                        <TableCell>
                          <span className="rounded-md border border-[#ff8a3d]/20 bg-[#ff8a3d]/5 px-1.5 py-0.5 font-mono text-xs text-[#ff8a3d]">
                            {route.protocol}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {route.provider || "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {route.priority}
                        </TableCell>
                        <TableCell>
                          {route.enabled ? (
                            <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                              <span className="size-1.5 rounded-full bg-emerald-400" />
                              Enabled
                            </span>
                          ) : (
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span className="size-1.5 rounded-full bg-muted-foreground" />
                              Disabled
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* ─── Models Grid ─── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Zap className="size-4 text-[#ff8a3d]" />
                Available Models
                <span className="ml-auto rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
                  {models.length} model{models.length !== 1 ? "s" : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {models.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No models available
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {models.map((model) => (
                    <div
                      key={model.id}
                      className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm font-medium text-foreground">
                          {model.id}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {model.protocols?.join(", ") || "openai-chat"}
                        </p>
                      </div>
                      <span className="ml-2 shrink-0 rounded-md border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {model.owned_by || "gateway"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
