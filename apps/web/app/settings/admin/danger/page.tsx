"use client";

import { AdminSubNav } from "../admin-sub-nav";
import { DangerZoneSection } from "../danger-zone-section";
import { NotFoundState } from "../not-found-state";
import { useSession } from "@/hooks/use-session";

export default function AdminDangerPage() {
  const { isAdmin, loading } = useSession();

  if (loading) {
    return null;
  }

  if (!isAdmin) {
    return <NotFoundState />;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <AdminSubNav />
      </div>
      <DangerZoneSection />
    </div>
  );
}
