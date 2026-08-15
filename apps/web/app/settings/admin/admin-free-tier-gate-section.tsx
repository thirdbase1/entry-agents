"use client";

import { AlertTriangle, Loader2, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  getAdminFreeTierGateStatus,
  setAdminFreeTierGateStatus,
} from "@/lib/admin/actions";
import type { PlatformSettingsRow } from "@/lib/db/platform-settings";

const DEFAULT_REASON =
  "We're at capacity right now -- please check back in a little while.";

/**
 * Global kill switch for free-tier model access. When off, every
 * non-admin user is blocked from starting new chat turns (server-side,
 * regardless of what the model selector shows) AND any turn already
 * streaming for a non-admin user is aborted within one poll tick of the
 * in-flight stop monitor -- see resolveChatModelRuntime and
 * startStopMonitor in app/workflows/chat.ts. Admins are never affected,
 * so this page stays reachable to flip it back on. The reason text is
 * shown to blocked users verbatim, in the chat and in the model selector,
 * so write it as a plain sentence for them, not an internal note.
 */
export function AdminFreeTierGateSection() {
  const [settings, setSettings] = useState<PlatformSettingsRow | null>(null);
  const [reasonDraft, setReasonDraft] = useState(DEFAULT_REASON);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getAdminFreeTierGateStatus()
      .then((row) => {
        if (cancelled) return;
        setSettings(row);
        setReasonDraft(row.disabledReason || DEFAULT_REASON);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load free-tier gate status.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggle(nextEnabled: boolean) {
    if (!settings) return;
    setPending(true);
    const reasonToSend = nextEnabled ? null : reasonDraft.trim() || DEFAULT_REASON;
    const previous = settings;

    setSettings({
      ...settings,
      freeTierEnabled: nextEnabled,
      disabledReason: reasonToSend,
    });

    try {
      await setAdminFreeTierGateStatus(nextEnabled, reasonToSend);
      toast.success(
        nextEnabled
          ? "Free tier re-enabled for all users."
          : "Free tier disabled -- blocked instantly for every non-admin user.",
      );
    } catch (err) {
      setSettings(previous);
      toast.error(
        err instanceof Error ? err.message : "Failed to update free-tier gate.",
      );
    } finally {
      setPending(false);
    }
  }

  async function handleSaveReason() {
    if (!settings || settings.freeTierEnabled) return;
    setPending(true);
    try {
      await setAdminFreeTierGateStatus(false, reasonDraft.trim() || DEFAULT_REASON);
      setSettings({
        ...settings,
        disabledReason: reasonDraft.trim() || DEFAULT_REASON,
      });
      toast.success("Reason updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update reason.");
    } finally {
      setPending(false);
    }
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </CardContent>
      </Card>
    );
  }

  if (!settings) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading free-tier gate status…
        </CardContent>
      </Card>
    );
  }

  const isDisabled = !settings.freeTierEnabled;

  return (
    <Card className={isDisabled ? "border-destructive/40" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldOff className="size-4" />
          Free tier access
        </CardTitle>
        <CardDescription>
          Master switch for every non-admin user's model access. Turning this
          off blocks the model selector and every new chat turn instantly,
          and stops any response that's already streaming, showing the
          reason below. You (admin) are never affected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">
              {isDisabled ? "Free tier is disabled" : "Free tier is live"}
            </p>
            <p className="text-xs text-muted-foreground">
              {isDisabled
                ? "Non-admin users can't send or continue any chat right now."
                : "All non-admin users can use any available model normally."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {pending && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
            <Switch
              checked={!isDisabled}
              disabled={pending}
              onCheckedChange={(checked) => handleToggle(checked)}
              aria-label="Toggle free tier access"
            />
          </div>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="free-tier-reason"
            className="text-xs font-medium text-muted-foreground"
          >
            Reason shown to blocked users
          </label>
          <Textarea
            id="free-tier-reason"
            value={reasonDraft}
            onChange={(e) => setReasonDraft(e.target.value)}
            placeholder={DEFAULT_REASON}
            rows={2}
            className="resize-none text-sm"
          />
          {isDisabled && (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={pending || reasonDraft.trim() === (settings.disabledReason || "")}
                onClick={handleSaveReason}
              >
                Update reason
              </Button>
            </div>
          )}
        </div>

        {settings.updatedAt.getTime() > 0 && (
          <p className="text-xs text-muted-foreground">
            Last changed {settings.updatedAt.toLocaleString()}
            {settings.updatedBy ? ` by ${settings.updatedBy}` : ""}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
