"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { fetcher } from "@/lib/swr";

type Provider = "vercel" | "google" | "github";

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: "vercel", label: "Vercel" },
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
];

function ProviderIcon({ provider }: { provider: Provider }) {
  if (provider === "vercel") {
    return <span aria-hidden="true">▲</span>;
  }
  if (provider === "google") {
    return <span aria-hidden="true">G</span>;
  }
  return <span aria-hidden="true">◉</span>;
}

export function ProviderConnectionsSection() {
  const { data, isLoading, mutate } = useSWR<{ providers: string[] }>(
    "/api/auth/accounts",
    fetcher,
  );
  const [linking, setLinking] = useState<Provider | null>(null);

  async function connect(provider: Provider) {
    setLinking(provider);
    await authClient.linkSocial({
      provider,
      callbackURL: "/settings/connections",
      errorCallbackURL: "/settings/connections",
    });
    await mutate();
    setLinking(null);
  }

  return (
    <div className="rounded-lg border border-border/50 bg-muted/10">
      <div className="border-b border-border/50 px-4 py-3">
        <div className="text-sm font-medium">Sign-in methods</div>
        <p className="mt-2 text-xs text-muted-foreground">
          Connect Vercel, Google, or GitHub to use any of them when signing in.
        </p>
      </div>
      <div className="space-y-3 p-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading connections...</div>
        ) : (
          PROVIDERS.map(({ id, label }) => {
            const connected = data?.providers.includes(id) ?? false;
            const busy = linking === id;
            return (
              <div className="flex items-center justify-between gap-3" key={id}>
                <div className="flex items-center gap-2 text-sm">
                  <span className="flex size-7 items-center justify-center rounded-full border border-border/60 text-xs font-semibold">
                    <ProviderIcon provider={id} />
                  </span>
                  <span>{label}</span>
                </div>
                {connected ? (
                  <span className="text-xs text-muted-foreground">Connected</span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={linking !== null}
                    onClick={() => connect(id)}
                  >
                    {busy && <Loader2 className="mr-1.5 size-3 animate-spin" />}
                    Connect
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
