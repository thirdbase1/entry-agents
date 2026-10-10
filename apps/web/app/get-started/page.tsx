import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/session/get-server-session";
import { needsOnboarding } from "@/lib/onboarding";
import { GetStartedFlow } from "./get-started-flow";

export const metadata: Metadata = {
  title: "Get Started",
  description: "Set up your Entry Agents workspace.",
  // Auth-gated onboarding: anonymous visitors are redirected to "/", and
  // the flow itself is per-account, so there is no indexable content here.
  robots: { index: false, follow: true },
};

interface GetStartedPageProps {
  searchParams: Promise<{
    step?: string | string[];
  }>;
}

function getSingleSearchParam(
  value: string | string[] | undefined,
): string | null {
  if (typeof value === "string") {
    return value;
  }

  return null;
}

export default async function GetStartedPage({
  searchParams,
}: GetStartedPageProps) {
  const session = await getServerSession();
  if (!session?.user) {
    redirect("/");
  }

  const resolvedSearchParams = await searchParams;
  const requestedStep = getSingleSearchParam(resolvedSearchParams.step);
  const onboarding = await needsOnboarding(session.user.id);

  if (!onboarding && requestedStep !== "github") {
    redirect("/sessions");
  }

  return <GetStartedFlow />;
}
