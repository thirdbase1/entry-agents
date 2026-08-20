"use client";

import { formatTokens } from "@open-agents/shared";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Loader2,
  Minus,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  adjustAdminUserCredit,
  getAdminUserDetail,
  setAdminUserPlan,
} from "@/lib/admin/actions";
import { PLAN_CATALOG, PLAN_IDS, type PlanId } from "@/lib/billing/plans";
import type {
  AdminUserModelCallRow,
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

function formatDateTime(date: Date): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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
  modelCallLog: AdminUserModelCallRow[];
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
function formatUsdCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Admin-only plan override control. Lets support change a user's plan
 * tier directly (model access takes effect immediately -- see
 * modelAccess on PLAN_CATALOG and the free-tier gate in
 * app/workflows/chat.ts) for cases like a missed Paystack webhook or
 * comping an account. On upgrade to a costlier plan, offers to also
 * grant that plan's credit (since the admin action itself doesn't touch
 * Paystack/billing cycle state -- see setAdminUserPlan's doc comment).
 */
function PlanManagementCard({
  userId,
  profile,
  onChanged,
}: {
  userId: string;
  profile: AdminUserProfile;
  onChanged: (update: { plan: string; creditBalanceCents: number }) => void;
}) {
  const [selectedPlan, setSelectedPlan] = useState<PlanId>(
    (profile.plan as PlanId) ?? "free",
  );
  const [grantCredit, setGrantCredit] = useState(true);
  const [decreaseBalance, setDecreaseBalance] = useState(false);
  const [decreaseAmountInput, setDecreaseAmountInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedPlan((profile.plan as PlanId) ?? "free");
    setDecreaseBalance(false);
    setDecreaseAmountInput("");
  }, [profile.plan]);

  const currentPlanDef = PLAN_CATALOG[(profile.plan as PlanId) ?? "free"];
  const targetPlanDef = PLAN_CATALOG[selectedPlan];
  const isUpgradeInPrice =
    targetPlanDef.priceUsdCents > currentPlanDef.priceUsdCents;
  const isDowngradeInPrice =
    targetPlanDef.priceUsdCents < currentPlanDef.priceUsdCents;
  const isChanged = selectedPlan !== profile.plan;

  const parsedDecreaseAmountCents = Math.round(
    (Number.parseFloat(decreaseAmountInput) || 0) * 100,
  );
  const isDecreaseAmountValid =
    !decreaseBalance ||
    (parsedDecreaseAmountCents > 0 &&
      Number.isFinite(parsedDecreaseAmountCents));

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const grantCents =
        isChanged && grantCredit && isUpgradeInPrice
          ? targetPlanDef.creditGrantCents
          : 0;
      const debitCents =
        isChanged && isDowngradeInPrice && decreaseBalance
          ? parsedDecreaseAmountCents
          : 0;

      if (debitCents > 0 && !isDecreaseAmountValid) {
        setSaveError("Enter a valid amount to decrease.");
        setSaving(false);
        return;
      }

      const result = await setAdminUserPlan(
        userId,
        selectedPlan,
        grantCents,
        debitCents,
      );
      onChanged(result);
      setDecreaseBalance(false);
      setDecreaseAmountInput("");
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to update plan.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan &amp; credit</CardTitle>
        <CardDescription>
          Override this user&apos;s subscription tier. Takes effect immediately,
          no redeploy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">Current balance</span>
          <span className="font-medium">
            {formatUsdCents(profile.creditBalanceCents)}
          </span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[160px]">
            <p className="mb-1.5 text-xs text-muted-foreground">Plan</p>
            <Select
              value={selectedPlan}
              onValueChange={(value) => setSelectedPlan(value as PlanId)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a plan" />
              </SelectTrigger>
              <SelectContent>
                {PLAN_IDS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {PLAN_CATALOG[id].name}
                    {PLAN_CATALOG[id].priceUsdCents > 0
                      ? ` — $${(PLAN_CATALOG[id].priceUsdCents / 100).toFixed(0)}/mo`
                      : " — Free"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            onClick={handleSave}
            disabled={!isChanged || saving || !isDecreaseAmountValid}
          >
            {saving ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : null}
            Save plan
          </Button>
        </div>

        {isChanged && isUpgradeInPrice && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={grantCredit}
              onChange={(e) => setGrantCredit(e.target.checked)}
              className="size-3.5"
            />
            Also grant {targetPlanDef.name}&apos;s credit (
            {formatUsdCents(targetPlanDef.creditGrantCents)}) -- for comping
            this account or fixing a missed payment webhook.
          </label>
        )}

        {isChanged && isDowngradeInPrice && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={decreaseBalance}
                onChange={(e) => setDecreaseBalance(e.target.checked)}
                className="size-3.5"
              />
              Also decrease this user&apos;s balance -- e.g. clawing back unused
              credit on a downgrade.
            </label>

            {decreaseBalance && (
              <div className="flex items-center gap-2 pl-6">
                <span className="text-sm text-muted-foreground">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={decreaseAmountInput}
                  onChange={(e) => setDecreaseAmountInput(e.target.value)}
                  placeholder="0.00"
                  className="w-24 rounded-md border border-input bg-background px-2 py-1 text-sm"
                />
                <span className="text-xs text-muted-foreground">
                  Amount to decrease (capped at their current balance of{" "}
                  {formatUsdCents(profile.creditBalanceCents)})
                </span>
              </div>
            )}

            {decreaseBalance && !isDecreaseAmountValid && (
              <p className="pl-6 text-xs text-destructive">
                Enter an amount greater than $0.
              </p>
            )}
          </div>
        )}

        {isChanged && !isUpgradeInPrice && !isDowngradeInPrice && (
          <p className="text-xs text-muted-foreground">
            Lateral plan change -- model access changes only, credit balance is
            left untouched.
          </p>
        )}

        {saveError && <p className="text-sm text-destructive">{saveError}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Standalone add/remove credit control -- for one-off corrections (e.g.
 * crediting a user back for a billing bug, or clawing back a mistaken
 * grant) that aren't tied to a plan change. Always logged as an
 * "admin_adjustment" ledger entry with an optional reason for the audit
 * trail. Remove is capped server-side at the user's current balance.
 */
function CreditAdjustmentCard({
  userId,
  creditBalanceCents,
  onChanged,
}: {
  userId: string;
  creditBalanceCents: number;
  onChanged: (creditBalanceCents: number) => void;
}) {
  const [amountInput, setAmountInput] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState<"add" | "remove" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSuccess, setLastSuccess] = useState<string | null>(null);

  const parsedAmountCents = Math.round(
    (Number.parseFloat(amountInput) || 0) * 100,
  );
  const isAmountValid =
    parsedAmountCents > 0 && Number.isFinite(parsedAmountCents);

  async function handleAdjust(direction: "add" | "remove") {
    if (!isAmountValid) {
      setSaveError("Enter an amount greater than $0.");
      return;
    }
    setSaving(direction);
    setSaveError(null);
    setLastSuccess(null);
    try {
      const result = await adjustAdminUserCredit(
        userId,
        direction,
        parsedAmountCents,
        reason,
      );
      onChanged(result.creditBalanceCents);
      setLastSuccess(
        `${direction === "add" ? "Added" : "Removed"} $${(parsedAmountCents / 100).toFixed(2)}. New balance: ${formatUsdCents(result.creditBalanceCents)}.`,
      );
      setAmountInput("");
      setReason("");
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to adjust credit.",
      );
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add / remove credit</CardTitle>
        <CardDescription>
          One-off manual correction to this user&apos;s balance. Logged in the
          ledger with your admin id and the reason below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">Current balance</span>
          <span className="font-medium">
            {formatUsdCents(creditBalanceCents)}
          </span>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">Amount</p>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">$</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder="0.00"
                className="w-28 rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
            </div>
          </div>

          <div className="min-w-[200px] flex-1">
            <p className="mb-1.5 text-xs text-muted-foreground">
              Reason (optional, shown in the ledger)
            </p>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. refund for gpt-5.6 pricing bug"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </div>

          <Button
            onClick={() => handleAdjust("add")}
            disabled={!isAmountValid || saving !== null}
          >
            {saving === "add" ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1.5 size-3.5" />
            )}
            Add credit
          </Button>

          <Button
            variant="outline"
            onClick={() => handleAdjust("remove")}
            disabled={!isAmountValid || saving !== null}
          >
            {saving === "remove" ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Minus className="mr-1.5 size-3.5" />
            )}
            Remove credit
          </Button>
        </div>

        {saveError && <p className="text-sm text-destructive">{saveError}</p>}
        {lastSuccess && !saveError && (
          <p className="text-sm text-emerald-500">{lastSuccess}</p>
        )}
      </CardContent>
    </Card>
  );
}

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

          <PlanManagementCard
            userId={userId}
            profile={data.profile}
            onChanged={(update) => {
              setData((prev) =>
                prev?.profile
                  ? {
                      ...prev,
                      profile: {
                        ...prev.profile,
                        plan: update.plan,
                        creditBalanceCents: update.creditBalanceCents,
                      },
                    }
                  : prev,
              );
            }}
          />

          <CreditAdjustmentCard
            userId={userId}
            creditBalanceCents={data.profile.creditBalanceCents}
            onChanged={(creditBalanceCents) => {
              setData((prev) =>
                prev?.profile
                  ? {
                      ...prev,
                      profile: {
                        ...prev.profile,
                        creditBalanceCents,
                      },
                    }
                  : prev,
              );
            }}
          />

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

          <Card>
            <CardHeader>
              <CardTitle>Model call log</CardTitle>
              <CardDescription>
                Every individual model call (most recent{" "}
                {data.modelCallLog.length}), with its own input/cached/output
                tokens and cost -- not aggregated. Use this to spot a single
                turn that spiraled into an unusually long or expensive tool-call
                chain.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.modelCallLog.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No model calls recorded.
                </p>
              ) : (
                <div className="max-h-[480px] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Model</TableHead>
                        <TableHead className="text-right">Tool calls</TableHead>
                        <TableHead className="text-right">Input</TableHead>
                        <TableHead className="text-right">Cached</TableHead>
                        <TableHead className="text-right">Output</TableHead>
                        <TableHead className="text-right">Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.modelCallLog.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                            {formatDateTime(row.createdAt)}
                          </TableCell>
                          <TableCell className="font-medium">
                            {row.modelId}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right tabular-nums",
                              row.toolCallCount >= 15 &&
                                "font-semibold text-amber-500",
                            )}
                          >
                            {row.toolCallCount}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatTokens(row.inputTokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {formatTokens(row.cachedInputTokens)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatTokens(row.outputTokens)}
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
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
