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
  ok: boolean;
  status: string;
  uptime: number;
  routes: number;
  routedModels: string[];
  providers: string[];
  circuitBreakers: Record<string, string>;
  activeRequests: number;
  activeStreams: number;
  // version/gitCommit aren't in the real /health payload today, but keep
  // them optional in case they're added later -- avoids re-breaking this.
  version?: string;
  gitCommit?: string | null;
}

interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

interface MetricsBucket {
  requests: number;
  requests2xx: number;
  requests4xx: number;
  requests5xx: number;
  upstreamErrors: number;
  fallbacks: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
  };
  estimatedSpend: number;
  latency: LatencyStats;
  ttft: LatencyStats;
  statusBreakdown: Record<string, number>;
}

interface CircuitBreakerDetail {
  state: string;
  failures: number;
  openedAt: number;
}

interface MetricsResponse {
  uptime: number;
  activeRequests: number;
  activeStreams: number;
  global: MetricsBucket;
  byProvider: Record<string, MetricsBucket>;
  byModel: Record<string, MetricsBucket>;
  circuitBreakers: Record<string, CircuitBreakerDetail>;
  providers: string[];
  modelCount: number;
  providerCount: number;
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

function LatencyChart({ histogram }: { histogram?: LatencyStats }) {
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
  breakdown,
}: {
  breakdown?: Record<string, number>;
}) {
  if (!breakdown || Object.keys(breakdown).length === 0) {
    return (
      <div className="text-sm text-muted-foreground">No request data yet</div>
    );
  }

  const entries = Object.entries(breakdown)
    .map(([status, count]) => ({ status: Number(status), count }))
    .sort((a, b) => b.count - a.count);

  const total = entries.reduce((sum, e) => sum + e.count, 0);

  return (
    <div className="space-y-2">
      {entries.map((entry) => {
        const pct = total ? (entry.count / total) * 100 : 0;
        const is2xx = entry.status >= 200 && entry.status < 300;
        const is4xx = entry.status >= 400 && entry.status < 500;
        const is5xx = entry.status >= 500;

        return (
          <div key={entry.status} className="flex items-center gap-3">
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

// ─── Usage Breakdown Table (shared by per-provider and per-model) ───────────

function UsageBreakdownTable({
  buckets,
  nameHeader,
  circuitBreakers,
  cbKeyPrefix,
}: {
  buckets: Record<string, MetricsBucket>;
  nameHeader: string;
  circuitBreakers?: Record<string, CircuitBreakerDetail>;
  cbKeyPrefix?: boolean;
}) {
  const names = Object.keys(buckets);
  if (names.length === 0) {
    return <div className="text-sm text-muted-foreground">No data yet</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{nameHeader}</TableHead>
          <TableHead className="text-right">Requests</TableHead>
          <TableHead className="text-right">2xx</TableHead>
          <TableHead className="text-right">4xx</TableHead>
          <TableHead className="text-right">5xx</TableHead>
          <TableHead className="text-right">Tokens In</TableHead>
          <TableHead className="text-right">Tokens Out</TableHead>
          <TableHead className="text-right">Spend</TableHead>
          <TableHead className="text-right">p50</TableHead>
          <TableHead className="text-right">Errors</TableHead>
          {cbKeyPrefix && <TableHead>Health</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {names.map((name) => {
          const b = buckets[name];
          let cbState: string | undefined;
          if (cbKeyPrefix && circuitBreakers) {
            const cbKey = Object.keys(circuitBreakers).find((k) =>
              k.startsWith(`${name}:`),
            );
            cbState = cbKey ? circuitBreakers[cbKey].state : "closed";
          }
          return (
            <TableRow key={name}>
              <TableCell className="font-mono text-xs">{name}</TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatNumber(b.requests || 0)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-emerald-400">
                {formatNumber(b.requests2xx || 0)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-amber-400">
                {formatNumber(b.requests4xx || 0)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-red-400">
                {formatNumber(b.requests5xx || 0)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatNumber(b.tokens?.input || 0)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatNumber(b.tokens?.output || 0)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-[#ff8a3d]">
                ${(b.estimatedSpend || 0).toFixed(4)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {b.latency?.count ? formatLatency(b.latency.p50) : "—"}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatNumber(b.upstreamErrors || 0)}
              </TableCell>
              {cbKeyPrefix && (
                <TableCell>
                  <span
                    className={cn("font-mono text-xs", cnStatus(cbState || ""))}
                  >
                    {cbState || "—"}
                  </span>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

const STORAGE_KEY = "entry-gateway-dashboard-connection";

function loadSavedConnection(): { url: string; key: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.url === "string") {
      return {
        url: parsed.url,
        key: typeof parsed.key === "string" ? parsed.key : "",
      };
    }
  } catch {
    // ignore corrupt storage
  }
  return null;
}

export function GatewayDashboard() {
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [routes, setRoutes] = useState<RouteInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (url: string, key: string) => {
    const headers: Record<string, string> = {};
    if (key) headers["Authorization"] = `Bearer ${key}`;

    try {
      const [healthRes, metricsRes, modelsRes, routesRes] = await Promise.all([
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
  }, []);

  const handleConnect = async (opts?: {
    url?: string;
    key?: string;
    persist?: boolean;
  }) => {
    const url = (opts?.url ?? gatewayUrl).trim().replace(/\/+$/, "");
    const key = (opts?.key ?? apiKey).trim();
    if (!url) return;
    setConnecting(true);
    setError(null);
    await fetchData(url, key);
    setConnecting(false);
    setConnected(true);

    if (opts?.persist !== false && typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ url, key }));
      } catch {
        // storage full/unavailable -- not worth failing the connection over
      }
    }

    // Auto-refresh every 5 seconds
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => fetchData(url, key), 5000);
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

  // On first mount: reconnect with whatever this browser already had
  // saved (so the dashboard stops asking for credentials on every visit),
  // otherwise fall back to the admin-only server default (GATEWAY_BASE_URL
  // / GATEWAY_API_KEY), otherwise just show the empty connect form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = loadSavedConnection();
      if (saved?.url) {
        setGatewayUrl(saved.url);
        setApiKey(saved.key);
        if (!cancelled)
          await handleConnect({
            url: saved.url,
            key: saved.key,
            persist: false,
          });
        if (!cancelled) setRestoring(false);
        return;
      }

      try {
        const res = await fetch("/api/settings/gateway-defaults");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && data?.baseUrl) {
            setGatewayUrl(data.baseUrl);
            setApiKey(data.apiKey || "");
            await handleConnect({ url: data.baseUrl, key: data.apiKey || "" });
          }
        }
      } catch {
        // no server default available -- fine, user can enter manually
      }
      if (!cancelled) setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The real /metrics response nests everything under `global`
  // (requests/latency/tokens/spend/statusBreakdown), plus separate
  // `byProvider` and `byModel` breakdowns -- there is no flat
  // counters/gauges/histograms shape. Reading the wrong keys is why this
  // dashboard used to show 0 for everything despite real traffic.
  const g = metrics?.global;
  const latencyStats = g?.latency;
  const requestTotal = g?.requests || 0;
  const tokensTotal = g?.tokens?.total || 0;
  const spendTotal = g?.estimatedSpend || 0;
  const upstreamErrors = g?.upstreamErrors || 0;
  const activeRequests = metrics?.activeRequests ?? health?.activeRequests ?? 0;
  const activeStreams = metrics?.activeStreams ?? 0;
  const statusBreakdown = g?.statusBreakdown || {};

  return (
    <div className="space-y-6">
      {/* ─── Connection Bar ─── */}
      <Card className="overflow-hidden">
        <CardContent className="pt-0">
          <div className="flex flex-col gap-4 py-6 lg:flex-row lg:items-end">
            <div className="flex-1 space-y-2">
              <label
                htmlFor="gateway-url-input"
                className="text-xs font-medium text-muted-foreground"
              >
                Gateway URL
              </label>
              <Input
                id="gateway-url-input"
                type="url"
                placeholder="https://your-gateway.example.com"
                value={gatewayUrl}
                onChange={(e) => setGatewayUrl(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex-1 space-y-2">
              <label
                htmlFor="gateway-api-key-input"
                className="text-xs font-medium text-muted-foreground"
              >
                Admin API Key
              </label>
              <Input
                id="gateway-api-key-input"
                type="password"
                placeholder="gw_live_..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={() => handleConnect()}
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
                <Button onClick={handleRefresh} variant="outline" size="icon">
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
              {health.version && (
                <>
                  <span className="text-muted-foreground">
                    v{health.version}
                  </span>
                  <span className="text-muted-foreground">·</span>
                </>
              )}
              <span className="font-mono text-xs text-muted-foreground">
                {lastRefresh ? lastRefresh.toLocaleTimeString() : "—"}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {!connected && !connecting && !restoring && (
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
              value={
                latencyStats?.count ? formatLatency(latencyStats.p50 || 0) : "—"
              }
              sublabel={
                latencyStats?.count
                  ? `p95: ${formatLatency(latencyStats.p95 || 0)}`
                  : undefined
              }
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
                <LatencyChart histogram={latencyStats} />
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
                <StatusBreakdown breakdown={statusBreakdown} />
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

          {/* ─── Per-Model Usage ─── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="size-4 text-[#ff8a3d]" />
                Model Usage
                <span className="ml-auto rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
                  {metrics?.modelCount ??
                    Object.keys(metrics?.byModel || {}).length}{" "}
                  model
                  {(metrics?.modelCount ??
                    Object.keys(metrics?.byModel || {}).length) !== 1
                    ? "s"
                    : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto pt-0">
              <UsageBreakdownTable
                buckets={metrics?.byModel || {}}
                nameHeader="Model"
              />
            </CardContent>
          </Card>

          {/* ─── Per-Provider Usage ─── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="size-4 text-[#ff8a3d]" />
                Provider Usage
                <span className="ml-auto rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
                  {metrics?.providerCount ??
                    Object.keys(metrics?.byProvider || {}).length}{" "}
                  provider
                  {(metrics?.providerCount ??
                    Object.keys(metrics?.byProvider || {}).length) !== 1
                    ? "s"
                    : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto pt-0">
              <UsageBreakdownTable
                buckets={metrics?.byProvider || {}}
                nameHeader="Provider"
                circuitBreakers={metrics?.circuitBreakers}
                cbKeyPrefix
              />
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
