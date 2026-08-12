"use client";

import { useSession } from "@/hooks/use-session";
import { AdminAlertBanner } from "./admin-alert-banner";
import { AdminSubNav } from "./admin-sub-nav";
import { NotFoundState } from "./not-found-state";

/**
 * Shared shell for every /settings/admin/* route: the admin gate,
 * heading, sub-nav, and the live model-error alert banner. Individual
 * pages only render their own section content.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
      <AdminAlertBanner />
      {children}
    </div>
  );
}
