"use client";

import { useSession } from "@/hooks/use-session";
import { AdminActivityChart } from "./admin-activity-chart";
import { AdminModelHealthSection } from "./admin-model-health-section";
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

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <AdminActivityChart />
        </div>
        <div className="lg:col-span-3">
          <AdminModelHealthSection />
        </div>
      </div>

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
