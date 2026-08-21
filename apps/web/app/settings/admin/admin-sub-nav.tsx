"use client";

import { Cpu, Gauge, ShieldAlert, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ADMIN_TABS = [
  {
    id: "overview",
    label: "Overview",
    href: "/settings/admin",
    icon: ShieldAlert,
  },
  {
    id: "users",
    label: "Users",
    href: "/settings/admin/users",
    icon: Users,
  },
  {
    id: "models",
    label: "Models",
    href: "/settings/admin/models",
    icon: Cpu,
  },
  {
    id: "benchmarks",
    label: "Benchmarks",
    href: "/settings/admin/benchmarks",
    icon: Gauge,
  },
  {
    id: "danger",
    label: "Danger Zone",
    href: "/settings/admin/danger",
    icon: TriangleAlert,
  },
] as const;

/**
 * Segmented sub-nav for the admin section, matching the same tab-chip
 * design token used by AdminUsageSection's date-range picker
 * (rounded-md border, bg-secondary active state).
 */
export function AdminSubNav() {
  const pathname = usePathname();

  return (
    <div className="flex gap-1 rounded-md border p-0.5">
      {ADMIN_TABS.map((tab) => {
        const isActive =
          tab.href === "/settings/admin"
            ? pathname === tab.href
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.id}
            href={tab.href}
            className={cn(
              "flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors",
              isActive
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <tab.icon className="size-3.5" />
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
