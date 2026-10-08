import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountsSection, AccountsSectionSkeleton } from "../accounts-section";
import { VercelSection, VercelSectionSkeleton } from "../vercel-section";
import { ProviderConnectionsSection } from "../provider-connections-section";

export const metadata: Metadata = {
  title: "Connections",
  description: "Manage your connected accounts and integrations.",
};

export default function ConnectionsPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Connections</h1>
      <Suspense fallback={<VercelSectionSkeleton />}>
        <VercelSection />
      </Suspense>
      <ProviderConnectionsSection />
      <Suspense fallback={<AccountsSectionSkeleton />}>
        <AccountsSection />
      </Suspense>
    </>
  );
}
