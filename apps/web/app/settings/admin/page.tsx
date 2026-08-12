"use client";

import { useSession } from "@/hooks/use-session";
import { AdminPlatformStatsSection } from "./admin-platform-stats-section";
import { AdminSubNav } from "./admin-sub-nav";
import { AdminUsageSection } from "./admin-usage-section";
import { NotFoundState } from "./not-found-state";

function AdminOverviewContent() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <AdminSubNav />
      </div>

      <AdminPlatformStatsSection />
      <AdminUsageSection />
    </div>
  );
}

export default function AdminPage() {
  const { isAdmin, loading } = useSession();

  if (loading) {
    return null;
  }

  if (!isAdmin) {
    return <NotFoundState />;
  }

  return <AdminOverviewContent />;
}
