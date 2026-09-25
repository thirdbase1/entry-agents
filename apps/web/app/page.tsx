import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getServerSession } from "@/lib/session/get-server-session";
import { HomePage } from "./home-page";

// entry-agents.dev, entry-agents.vercel.app and www.* all serve this page;
// without a canonical, crawlers pick a host themselves and split the
// ranking signals across three URLs for the same content.
export const metadata: Metadata = {
  alternates: {
    canonical: "/",
  },
};

export default async function Home() {
  const session = await getServerSession();
  if (session?.user) {
    redirect("/sessions");
  }

  return <HomePage hasSessionCookie={false} lastRepo={null} />;
}
