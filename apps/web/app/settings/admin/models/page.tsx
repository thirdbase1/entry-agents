"use client";

import { AdminFreeTierGateSection } from "../admin-free-tier-gate-section";
import { AdminModelsSection } from "../admin-models-section";

export default function AdminModelsPage() {
  return (
    <div className="space-y-6">
      <AdminFreeTierGateSection />
      <AdminModelsSection />
    </div>
  );
}
