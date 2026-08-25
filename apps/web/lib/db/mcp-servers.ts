import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  decryptMcpHeaders,
  encryptMcpHeaders,
} from "@/lib/mcp/header-encryption";
import { resolveAndAssertPublic } from "@/lib/mcp/url-safety";
import { db } from "./client";
import { mcpServers, type McpServerRow } from "./schema";

export interface McpServerSummary {
  id: string;
  name: string;
  transport: "http" | "sse";
  url: string;
  hasHeaders: boolean;
  enabled: boolean;
  lastConnectionError: string | null;
  lastConnectionCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class InvalidMcpServerNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMcpServerNameError";
  }
}

function assertValidName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new InvalidMcpServerNameError(
      "Name must be 1-32 characters, lowercase letters/numbers/hyphens/underscores, starting with a letter or number",
    );
  }
}

function toSummary(row: McpServerRow): McpServerSummary {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    hasHeaders: Boolean(row.encryptedHeaders),
    enabled: row.enabled,
    lastConnectionError: row.lastConnectionError,
    lastConnectionCheckedAt: row.lastConnectionCheckedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Never returns decrypted headers -- for display/listing only. */
export async function listMcpServers(
  userId: string,
): Promise<McpServerSummary[]> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.userId, userId));

  return rows.map(toSummary);
}

/**
 * For internal use only (the chat request path) -- resolves a user's
 * enabled servers with their headers decrypted, ready to hand to
 * createMcpToolSet(). Never expose this return value to a client.
 */
export async function getEnabledMcpServersForRequest(userId: string): Promise<
  {
    name: string;
    transport: "http" | "sse";
    url: string;
    headers?: Record<string, string>;
  }[]
> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.userId, userId), eq(mcpServers.enabled, true)));

  return rows.map((row) => ({
    name: row.name,
    transport: row.transport,
    url: row.url,
    headers: decryptMcpHeaders(row.encryptedHeaders),
  }));
}

export async function createMcpServer(params: {
  userId: string;
  name: string;
  transport: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}): Promise<McpServerSummary> {
  assertValidName(params.name);
  await resolveAndAssertPublic(params.url);

  const [created] = await db
    .insert(mcpServers)
    .values({
      id: nanoid(),
      userId: params.userId,
      name: params.name,
      transport: params.transport,
      url: params.url,
      encryptedHeaders: encryptMcpHeaders(params.headers),
      enabled: true,
    })
    .returning();

  return toSummary(created);
}

export async function updateMcpServer(params: {
  userId: string;
  id: string;
  name?: string;
  transport?: "http" | "sse";
  url?: string;
  /** Pass to replace headers. Omit to leave existing headers untouched
   * (the client never sees them back, so it can't round-trip them). */
  headers?: Record<string, string>;
  enabled?: boolean;
}): Promise<McpServerSummary | null> {
  if (params.name !== undefined) {
    assertValidName(params.name);
  }
  if (params.url !== undefined) {
    await resolveAndAssertPublic(params.url);
  }

  const [updated] = await db
    .update(mcpServers)
    .set({
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.transport !== undefined
        ? { transport: params.transport }
        : {}),
      ...(params.url !== undefined ? { url: params.url } : {}),
      ...(params.headers !== undefined
        ? { encryptedHeaders: encryptMcpHeaders(params.headers) }
        : {}),
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(eq(mcpServers.id, params.id), eq(mcpServers.userId, params.userId)),
    )
    .returning();

  return updated ? toSummary(updated) : null;
}

export async function deleteMcpServer(
  userId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))
    .returning({ id: mcpServers.id });

  return deleted.length > 0;
}

export async function recordMcpServerConnectionResult(
  id: string,
  error: string | null,
): Promise<void> {
  await db
    .update(mcpServers)
    .set({
      lastConnectionError: error,
      lastConnectionCheckedAt: new Date(),
    })
    .where(eq(mcpServers.id, id));
}
