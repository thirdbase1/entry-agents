"use client";

import { AdminSignupsSection } from "../admin-signups-section";
import { AdminUserLookupSection } from "../admin-user-lookup-section";

export default function AdminUsersPage() {
  return (
    <div className="space-y-6">
      <AdminUserLookupSection />
      <AdminSignupsSection />
    </div>
  );
}
