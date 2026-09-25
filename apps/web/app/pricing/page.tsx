import type { Metadata } from "next";
import { PlansCatalog } from "./plans-catalog";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Entry plans -- credit-based pricing, $1 in credit is $1 of usage. Checkout in Naira via Paystack.",
  alternates: {
    canonical: "/pricing",
  },
  openGraph: {
    url: "/pricing",
    title: "Entry Agents pricing — credit-based AI coding agent plans",
  },
  twitter: {
    title: "Entry Agents pricing — credit-based AI coding agent plans",
  },
};

export const dynamic = "force-dynamic";

/**
 * Public pricing page (owner 2026-09-15: "make plan page public and
 * name to pricing"): the plan catalog moved here from /billing/plans
 * so the public URL matches the "Pricing" name. /billing/plans now
 * redirects here; the model price table moved to /model.
 */
export default function PricingPage() {
  return (
    <PlansCatalog />
  );
}
