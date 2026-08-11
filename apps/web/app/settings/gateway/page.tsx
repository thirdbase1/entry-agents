"use client";

import { GatewayDashboard } from "@/components/gateway-dashboard";

export default function GatewayPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Gateway</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Monitor your entry-gateway — routes, metrics, circuit breakers, and
            real-time request health.
          </p>
        </div>
      </div>
      <GatewayDashboard />
    </div>
  );
}
