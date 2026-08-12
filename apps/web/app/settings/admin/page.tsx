"use client";

import { AdminActivityChart } from "./admin-activity-chart";
import { AdminModelHealthSection } from "./admin-model-health-section";
import { AdminPlatformStatsSection } from "./admin-platform-stats-section";
import { AdminUsageSection } from "./admin-usage-section";

export default function AdminPage() {
  return (
    <div className="space-y-6">
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
