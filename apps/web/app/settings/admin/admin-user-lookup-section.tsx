"use client";

import { formatTokens } from "@open-agents/shared";
import { AlertTriangle, Loader2, Search } from "lucide-react";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { lookupAdminUsers } from "@/lib/admin/actions";
import type { AdminUserLookupRow } from "@/lib/db/admin-directory";

function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

function initialsFor(row: AdminUserLookupRow): string {
  const source = row.name ?? row.username;
  return source.slice(0, 2).toUpperCase();
}

/**
 * Free-text search box for looking up a single user's connections,
 * session count, and all-time estimated spend -- an admin support tool
 * so "how much has this person used" doesn't require a database
 * console.
 */
export function AdminUserLookupSection() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AdminUserLookupRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSearch(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      setResults(null);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const rows = await lookupAdminUsers(trimmed);
      setResults(rows);
    } catch {
      setError("Failed to search users.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>User lookup</CardTitle>
        <CardDescription>
          Search by name, username, or email to see connections, sessions, and
          all-time estimated spend.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            runSearch(query);
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="jane@example.com"
              className="pl-8"
            />
          </div>
        </form>

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Searching…
          </div>
        )}

        {!isLoading && results !== null && results.length === 0 && (
          <p className="py-4 text-sm text-muted-foreground">
            No matching users.
          </p>
        )}

        {!isLoading && results && results.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Connections</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Est. spend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <Avatar className="size-7">
                        {row.avatarUrl && (
                          <AvatarImage
                            src={row.avatarUrl}
                            alt={row.name ?? row.username}
                          />
                        )}
                        <AvatarFallback className="text-[10px]">
                          {initialsFor(row)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                          {row.name ?? row.username}
                          {row.isAdmin && (
                            <Badge className="text-[10px]">Admin</Badge>
                          )}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {row.email ?? `@${row.username}`}
                        </span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1.5">
                      {row.githubConnected && (
                        <Badge variant="outline" className="text-[10px]">
                          GitHub
                        </Badge>
                      )}
                      {row.vercelConnected && (
                        <Badge variant="outline" className="text-[10px]">
                          Vercel
                        </Badge>
                      )}
                      {!row.githubConnected && !row.vercelConnected && (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.sessionCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.totalInputTokens + row.totalOutputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(row.estimatedCostUsd)}
                    {row.hasUnpricedUsage && (
                      <span className="ml-1 text-muted-foreground">+</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
