"use client";

import { AlertTriangle, Loader2, Plug, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useMcpServers } from "@/hooks/use-mcp-servers";

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold">{children}</h2>;
}

/** Parses lines like "Authorization: Bearer sk-..." into a header map.
 * Blank lines and lines without a colon are ignored -- kept lenient
 * since this is a plain textarea, not a structured key/value editor. */
function parseHeaderLines(raw: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key && value) {
      headers[key] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function McpServersSectionSkeleton() {
  return (
    <div className="space-y-4">
      <SectionHeader>MCP Servers</SectionHeader>
      <div className="rounded-lg border border-border/70">
        {Array.from({ length: 2 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0"
          >
            <div className="grid min-w-0 flex-1 gap-1">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="size-6 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function McpServersSection() {
  const { servers, loading, error, createServer, updateServer, deleteServer } =
    useMcpServers();

  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [url, setUrl] = useState("");
  const [headersRaw, setHeadersRaw] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const handleAdd = async () => {
    setFormError(null);
    if (!name.trim() || !url.trim()) {
      setFormError("Name and URL are required");
      return;
    }
    setIsSubmitting(true);
    try {
      await createServer({
        name: name.trim(),
        transport,
        url: url.trim(),
        headers: parseHeaderLines(headersRaw),
      });
      setName("");
      setUrl("");
      setHeadersRaw("");
      setTransport("http");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to add server");
    } finally {
      setIsSubmitting(false);
    }
  };

  const withPending = async (id: string, fn: () => Promise<void>) => {
    setPendingIds((prev) => new Set(prev).add(id));
    try {
      await fn();
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (loading) {
    return <McpServersSectionSkeleton />;
  }

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <SectionHeader>MCP Servers</SectionHeader>
        <p className="text-sm text-muted-foreground">
          Connect any MCP (Model Context Protocol) server to give the agent
          extra tools, in addition to its built-in ones. Tools from a server
          named &quot;linear&quot; show up to the agent as
          mcp__linear__&lt;tool&gt;. Every MCP tool call still goes through the
          same approval gate as web_fetch.
        </p>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0" />
            {error}
          </div>
        )}

        {servers.length > 0 && (
          <div className="rounded-lg border border-border/70">
            {servers.map((server) => (
              <div
                key={server.id}
                className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0"
              >
                <Plug className="size-4 shrink-0 text-muted-foreground" />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {server.name}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                      {server.transport}
                    </span>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {server.url}
                  </span>
                  {server.lastConnectionError && (
                    <span className="flex items-center gap-1 truncate text-xs text-destructive">
                      <AlertTriangle className="size-3 shrink-0" />
                      {server.lastConnectionError}
                    </span>
                  )}
                </div>
                {pendingIds.has(server.id) ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <>
                    <Switch
                      checked={server.enabled}
                      onCheckedChange={(checked) =>
                        withPending(server.id, () =>
                          updateServer(server.id, { enabled: checked }).then(
                            () => undefined,
                          ),
                        )
                      }
                      aria-label={`Enable ${server.name}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        withPending(server.id, () => deleteServer(server.id))
                      }
                      aria-label={`Remove ${server.name}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="grid gap-3 rounded-lg border border-dashed border-border/60 p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_140px] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                placeholder="linear"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-transport">Transport</Label>
              <Select
                value={transport}
                onValueChange={(v) => setTransport(v as "http" | "sse")}
              >
                <SelectTrigger id="mcp-transport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="sse">SSE</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-url">Server URL</Label>
            <Input
              id="mcp-url"
              placeholder="https://mcp.example.com/sse"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-headers">
              Headers (optional, one per line)
            </Label>
            <Textarea
              id="mcp-headers"
              placeholder={"Authorization: Bearer sk-..."}
              value={headersRaw}
              onChange={(e) => setHeadersRaw(e.target.value)}
              className="font-mono text-xs"
              rows={2}
            />
            <p className="text-xs text-muted-foreground">
              Stored encrypted. Never shown again after saving -- to change a
              header, remove the server and re-add it.
            </p>
          </div>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <Button onClick={handleAdd} disabled={isSubmitting} className="w-fit">
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Add server"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
