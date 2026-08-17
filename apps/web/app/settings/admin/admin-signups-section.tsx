"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getAdminSignups } from "@/lib/admin/actions";
import { getPlanDefinition } from "@/lib/billing/plans";
import type { AdminSignupRow } from "@/lib/db/admin-directory";

const SIGNUP_LIMIT = 12;

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initialsFor(row: AdminSignupRow): string {
  const source = row.name ?? row.username;
  return source.slice(0, 2).toUpperCase();
}

function planBadgeClassName(planId: string): string {
  switch (planId) {
    case "plus":
      return "border-sky-500/30 bg-sky-500/10 text-sky-400";
    case "pro":
      return "border-violet-500/30 bg-violet-500/10 text-violet-400";
    case "max":
      return "border-amber-500/30 bg-amber-500/10 text-amber-400";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

/** Most recently created accounts, for the admin Users tab. */
export function AdminSignupsSection() {
  const [data, setData] = useState<AdminSignupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getAdminSignups(SIGNUP_LIMIT)
      .then((rows) => {
        if (!cancelled) setData(rows);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load recent signups.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent signups</CardTitle>
        <CardDescription>
          The {SIGNUP_LIMIT} most recently created accounts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </div>
        ) : data ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Connections</TableHead>
                <TableHead className="text-right">Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`/settings/admin/users/${row.id}`}
                      className="flex items-center gap-2.5 hover:underline"
                    >
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
                        <span className="truncate text-sm font-medium">
                          {row.name ?? row.username}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {row.email ?? `@${row.username}`}
                        </span>
                      </div>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${planBadgeClassName(row.plan)}`}
                    >
                      {getPlanDefinition(row.plan).name}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(row.createdAt)}
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
                  <TableCell className="text-right">
                    {row.isAdmin && <Badge>Admin</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading signups…
          </div>
        )}
      </CardContent>
    </Card>
  );
}
