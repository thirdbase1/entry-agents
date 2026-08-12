"use client";

import { useParams } from "next/navigation";
import { AdminUserDetailView } from "../../admin-user-detail-view";

export default function AdminUserDetailPage() {
  const params = useParams<{ userId: string }>();
  return <AdminUserDetailView userId={params.userId} />;
}
