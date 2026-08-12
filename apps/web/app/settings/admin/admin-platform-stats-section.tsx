"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { getAdminStats } from "@/lib/admin/actions";
import type { AdminPlatformStats } from "@/lib/db/admin-platform-stats";
import { AdminStatCard } from "./admin-stat-card";

export function AdminPlatformStatsSection() {
  const [data, setData] = useState<AdminPlatformStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    getAdminStats()
      .then((stats) => {
        if (!cancelled) setData(stats);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load platform stats.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading platform stats…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        <AlertTriangle className="h-4 w-4" />
        {error ?? "Failed to load platform stats."}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h2 className="text-base font-semibold">Platform</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <AdminStatCard
          label="Total users"
          value={data.totalUsers.toLocaleString()}
          description={`+${data.newUsersLast7d} last 7d`}
        />
        <AdminStatCard
          label="Admins"
          value={data.totalAdmins.toLocaleString()}
        />
        <AdminStatCard
          label="Sessions"
          value={data.totalSessions.toLocaleString()}
          description={`${data.activeSessions} running`}
        />
        <AdminStatCard label="Chats" value={data.totalChats.toLocaleString()} />
        <AdminStatCard
          label="GitHub connected"
          value={data.githubConnectedUsers.toLocaleString()}
        />
        <AdminStatCard
          label="Vercel connected"
          value={data.vercelConnectedUsers.toLocaleString()}
        />
      </div>
    </div>
  );
}
