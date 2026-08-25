"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";

export interface McpServerSummary {
  id: string;
  name: string;
  transport: "http" | "sse";
  url: string;
  hasHeaders: boolean;
  enabled: boolean;
  lastConnectionError: string | null;
  lastConnectionCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListResponse {
  servers: McpServerSummary[];
}

interface SingleResponse {
  server: McpServerSummary;
}

export interface CreateMcpServerInput {
  name: string;
  transport: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface UpdateMcpServerInput {
  name?: string;
  transport?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

async function parseErrorOrThrow(res: Response, fallback: string) {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? fallback);
}

export function useMcpServers() {
  const { data, error, isLoading, mutate } = useSWR<ListResponse>(
    "/api/settings/mcp-servers",
    fetcher,
  );

  const createServer = async (
    input: CreateMcpServerInput,
  ): Promise<McpServerSummary> => {
    const res = await fetch("/api/settings/mcp-servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      await parseErrorOrThrow(res, "Failed to add MCP server");
    }
    const { server } = (await res.json()) as SingleResponse;
    await mutate();
    return server;
  };

  const updateServer = async (
    id: string,
    input: UpdateMcpServerInput,
  ): Promise<McpServerSummary> => {
    const res = await fetch(`/api/settings/mcp-servers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      await parseErrorOrThrow(res, "Failed to update MCP server");
    }
    const { server } = (await res.json()) as SingleResponse;
    await mutate();
    return server;
  };

  const deleteServer = async (id: string): Promise<void> => {
    const res = await fetch(`/api/settings/mcp-servers/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      await parseErrorOrThrow(res, "Failed to delete MCP server");
    }
    await mutate();
  };

  return {
    servers: data?.servers ?? [],
    loading: isLoading,
    error: error?.message ?? null,
    createServer,
    updateServer,
    deleteServer,
    refresh: mutate,
  };
}
