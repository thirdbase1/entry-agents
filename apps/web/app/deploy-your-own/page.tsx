import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const DEPLOY_ENV_VARS = [
  "POSTGRES_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "ENCRYPTION_KEY",
  "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID",
  "VERCEL_APP_CLIENT_SECRET",
  "NEXT_PUBLIC_GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "NEXT_PUBLIC_GITHUB_APP_SLUG",
  "GITHUB_WEBHOOK_SECRET",
] as const;

const DEPLOY_PRODUCTS = [
  {
    type: "integration",
    protocol: "storage",
    productSlug: "neon",
    integrationSlug: "neon",
  },
  {
    type: "integration",
    protocol: "storage",
    productSlug: "upstash-kv",
    integrationSlug: "upstash",
  },
] as const;

const DEPLOY_TEMPLATE_URL = (() => {
  const params = new URLSearchParams([
    ["project-name", "entry"],
    ["repository-name", "entry"],
    ["repository-url", "https://github.com/vercel-labs/entry"],
    ["demo-title", "Entry"],
    [
      "demo-description",
      "Open-source reference app for building and running background coding agents on Vercel.",
    ],
    ["demo-url", "https://entry.dev/"],
    ["env", DEPLOY_ENV_VARS.join(",")],
    [
      "envDescription",
      "Neon can provide POSTGRES_URL automatically. Generate BETTER_AUTH_SECRET and ENCRYPTION_KEY yourself, then add your Vercel OAuth and GitHub App credentials for a full deployment.",
    ],
    ["products", encodeURIComponent(JSON.stringify(DEPLOY_PRODUCTS))],
    ["skippable-integrations", "1"],
  ]);

  return `https://vercel.com/new/clone?${params.toString()}`;
})();

export const metadata: Metadata = {
  title: "Deploy your own",
  description:
    "Deploy your own copy of Entry to unlock the full template.",
};

export default function DeployYourOwnPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-24 text-foreground">
      <div className="flex max-w-xl flex-col items-center text-center">
        <p className="text-sm font-medium text-muted-foreground">Entry</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight">
          Deploy your own
        </h1>
        <p className="mt-4 text-base leading-7 text-muted-foreground">
          This hosted demo has limited functionality. Deploy your own copy to
          unlock the full Entry template.
        </p>
        <Button asChild className="mt-8" size="lg">
          <Link href={DEPLOY_TEMPLATE_URL} rel="noreferrer" target="_blank">
            Deploy your own version of this template now
          </Link>
        </Button>
      </div>
    </main>
  );
}
