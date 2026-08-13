"use client";

import { formatTokens } from "@entry/shared";
import { AlertTriangle, ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getAdminUserDetail } from "@/lib/admin/actions";
import type {
  AdminUserModelRow,
  AdminUserProfile,
  AdminUserSessionRow,
  AdminUserUsageDayRow,
} from "@/lib/db/admin-user-detail";
import { cn } from "@/lib/utils";

const USAGE_CHART_HEIGHT_PX = 72;
const USAGE_CHART_MIN_BAR_PX = 3;

function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initialsFor(profile: AdminUserProfile): string {
  const source = profile.name ?? profile.username;
  return source.slice(0, 2).toUpperCase();
}

const SESSION_STATUS_BADGE_CLASS: Record<
  AdminUserSessionRow["status"],
  string
> = {
  running: "border-blue-500/30 bg-blue-500/10 text-blue-400",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  archived: "border-muted-foreground/30 bg-muted text-muted-foreground",
};

interface UserDetailState {
  profile: AdminUserProfile | null;
  usageTrend: AdminUserUsageDayRow[];
  modelBreakdown: AdminUserModelRow[];
  sessions: AdminUserSessionRow[];
}

function UsageTrendChart({
  usageTrend,
}: {
  usageTrend: AdminUserUsageDayRow[];
}) {
  const maxTokens = Math.max(1, ...usageTrend.map((day) => day.totalTokens));

  return (
    <div className="flex h-[100px] items-end gap-1">
      {usageTrend.map((day) => {
        const height =
          day.totalTokens === 0
            ? USAGE_CHART_MIN_BAR_PX
            : Math.max(
                USAGE_CHART_MIN_BAR_PX,
                (day.totalTokens / maxTokens) * USAGE_CHART_HEIGHT_PX,
              );
        return (
          <Tooltip key={day.date}>
            <TooltipTrigger asChild>
              <div
                className="flex-1 rounded-sm bg-primary/70"
                style={{ height }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">{day.date}</p>
              <p>{formatTokens(day.totalTokens)} tokens</p>
              <p>{formatUsd(day.estimatedCostUsd)}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Admin drill-down: one user's full profile, daily usage trend, per-model
 * breakdown, and recent sessions. Linked from the Users tab's lookup and
 * signups tables so "how much has this person used, and on what" is one
 * click away instead of a database query.
 */
export function AdminUserDetailView({ userId }: { userId: string }) {
  const [data, setData] = useState<UserDetailState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getAdminUserDetail(userId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load user detail.");
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <div className="space-y-6">
      <Link
        href="/settings/admin/users"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to Users
      </Link>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      {!error && !data && (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading user…
        </div>
      )}

      {!error && data && !data.profile && (
        <p className="py-8 text-sm text-muted-foreground">
          No user found with id {userId}.
        </p>
      )}

      {!error && data?.profile && (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-start justify-between gap-6 pt-6">
              <div className="flex items-center gap-4">
                <Avatar className="size-14">
                  {data.profile.avatarUrl && (
                    <AvatarImage
                      src={data.profile.avatarUrl}
                      alt={data.profile.name ?? data.profile.username}
                    />
                  )}
                  <AvatarFallback>{initialsFor(data.profile)}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold">
                      {data.profile.name ?? data.profile.username}
                    </h2>
                    {data.profile.isAdmin && <Badge>Admin</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {data.profile.email ?? `@${data.profile.username}`}
                  </p>
                  <div className="mt-2 flex gap-1.5">
                    {data.profile.githubConnected && (
                      <Badge variant="outline" className="text-[10px]">
                        GitHub
                      </Badge>
                    )}
                    {data.profile.vercelConnected && (
                      <Badge variant="outline" className="text-[10px]">
                        Vercel
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-muted-foreground">Joined</p>
                  <p className="font-medium">
                    {formatDate(data.profile.createdAt)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Last login</p>
                  <p className="font-medium">
                    {formatDate(data.profile.lastLoginAt)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Sessions</p>
                  <p className="font-medium">{data.profile.sessionCount}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">All-time spend</p>
                  <p className="font-medium">
                    {formatUsd(data.profile.estimatedCostUsd)}
                    {data.profile.hasUnpricedUsage && (
                      <span className="ml-1 text-muted-foreground">+</span>
                    )}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Usage history</CardTitle>
              <CardDescription>
                Daily token usage, last 30 days.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <UsageTrendChart usageTrend={data.usageTrend} />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Model breakdown</CardTitle>
                <CardDescription>All-time, per model.</CardDescription>
              </CardHeader>
              <CardContent>
                {data.modelBreakdown.length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">
                    No usage recorded.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead>
                        <TableHead className="text-right">Events</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">Spend</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.modelBreakdown.map((row) => (
                        <TableRow key={row.modelId}>
                          <TableCell className="font-medium">
                            {row.modelId}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.eventCount}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatTokens(
                              row.totalInputTokens + row.totalOutputTokens,
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.estimatedCostUsd === undefined
                              ? "—"
                              : formatUsd(row.estimatedCostUsd)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent sessions</CardTitle>
                <CardDescription>Last 10 sessions.</CardDescription>
              </CardHeader>
              <CardContent>
                {data.sessions.length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">
                    No sessions yet.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Session</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.sessions.map((session) => (
                        <TableRow key={session.id}>
                          <TableCell>
                            <Link
                              href={`/sessions/${session.id}`}
                              className="flex items-center gap-1 font-medium hover:underline"
                            >
                              <span className="max-w-[180px] truncate">
                                {session.title}
                              </span>
                              <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                            </Link>
                            {session.repoOwner && session.repoName && (
                              <p className="text-xs text-muted-foreground">
                                {session.repoOwner}/{session.repoName}
                              </p>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px]",
                                SESSION_STATUS_BADGE_CLASS[session.status],
                              )}
                            >
                              {session.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {formatDate(session.updatedAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
