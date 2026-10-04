import { tool } from "ai";
import { z } from "zod";
import { isAgentContext } from "./utils";
import type { SandboxControlToolResult } from "../types";

/**
 * The actions this tool exposes.
 *
 * Pruned from the original set: `migrate` and `extend`.
 *
 *   - migrate: the workspace lives on a persistent Modal Volume, so
 *     re-provisioning a sandbox remounts the same files and there is no
 *     workspace to migrate. `connect()` already re-provisions
 *     automatically when a recorded sandbox has expired, so an
 *     agent-callable migrate would be a no-op that only risks killing
 *     in-flight work for nothing.
 *   - extend: Modal accepts `timeout`/`idle_timeout` only at creation,
 *     both bounded by the 24h hard cap, so there is no way to stretch a
 *     running sandbox from outside. The action existed only to paper
 *     over providers that needed it.
 *
 * `status`, `provision` and `reconnect` remain because they are the ones
 * the agent genuinely needs: a lazily-provisioned workspace has to be
 * started, and "is it running / paused / missing" is what every other
 * decision is based on. `snapshot` and `delete` stay destructive-but-
 * genuine (the host implements both through the same code the UI uses).
 */
const sandboxActionSchema = z.enum([
  "status",
  "provision",
  "reconnect",
  "snapshot",
  "delete",
]);

const sandboxControlInputSchema = z.object({
  action: sandboxActionSchema.describe(
    "Which workspace operation to run. 'status' is read-only and always safe.",
  ),
});

export type SandboxControlToolInput = z.infer<typeof sandboxControlInputSchema>;

/**
 * Agent-facing control of this session's workspace (sandbox) lifecycle.
 *
 * WHY THIS EXISTS (owner request): agents had no way to act on the
 * workspace itself -- they could only react when a tool failed. Provisioning
 * a session that never got a workspace, migrating one that is about to hit
 * its hard duration cap, extending one that is about to expire mid-task, or
 * tearing one down when it is no longer needed were all things the *user*
 * had to do by hand from the UI.
 *
 * Everything destructive (provision, migrate, delete) is executed by the
 * host through the SAME code paths the UI and the scheduled lifecycle
 * workflow use -- this tool only chooses which one to run and reports the
 * outcome. There is no second implementation of provisioning or migration
 * here to drift out of sync.
 *
 * `status` never mutates anything and needs no special permission.
 */
/**
 * Host results are spread FIRST and the tool's own envelope fields LAST.
 * The precedence matters: performSandboxMigration (and the provisioning
 * kick) return their own `action` field, which would otherwise overwrite
 * the action this tool reports and make the result unreadable to the model.
 */
function hostResult(
  host: Record<string, unknown>,
  action: string,
): SandboxControlToolResult {
  return { ...host, success: true, action };
}

export function sandboxControlTool() {
  return tool({
    description: `Control this session's workspace (sandbox) lifecycle: check its state, start/provision it, resume a paused one, snapshot it, or delete it.

ACTIONS:
- status: read-only. Returns whether the workspace is running, paused, or missing, its lifecycle state, and when it expires. ALWAYS call this first -- most lifecycle decisions are wrong without it.
- provision: start the workspace for this session. Use when status reports no workspace and the task needs file or shell access.
- reconnect: resume a paused/stopped workspace from its persisted state. Use when status reports paused and the task needs the files back.
- snapshot: capture a restorable snapshot of the workspace filesystem. Use before a risky change, or to preserve state you want to come back to.
- delete: stop and tear down the workspace. This DESTROYS uncommitted work -- only use it when the user explicitly asks, or when the workspace is confirmed empty/disposable.

The workspace is stored on a persistent volume, so it survives sandbox restarts and there is no migration or expiry extension to trigger -- a stopped sandbox is resumed with reconnect, and re-provisioning picks up the same files automatically.

IMPORTANT:
- These operations take effect for the whole session, not just your turn. Anything running in the workspace right now is interrupted.
- 'delete' is irreversible. Never delete on a guess -- confirm with the user first unless they asked for it.
- Provisioning is asynchronous: status may still report 'starting' immediately after you call it. Answer the user with what you know and let the workspace come up.`,
    inputSchema: sandboxControlInputSchema,
    execute: async (
      input,
      { experimental_context },
    ): Promise<SandboxControlToolResult> => {
      if (
        !isAgentContext(experimental_context) ||
        !experimental_context.sandboxControl
      ) {
        return {
          success: false,
          action: input.action,
          error:
            "Workspace lifecycle control isn't available in this environment.",
        };
      }

      const control = experimental_context.sandboxControl;

      try {
        switch (input.action) {
          case "status": {
            const status = await control.status();
            return hostResult(status, input.action);
          }
          case "provision": {
            const provisioned = await control.provision();
            return hostResult(provisioned, input.action);
          }
          case "reconnect": {
            const reconnected = await control.reconnect();
            return hostResult(reconnected, input.action);
          }
          case "snapshot": {
            const snapshotted = await control.snapshot();
            return hostResult(snapshotted, input.action);
          }
          case "delete": {
            const deleted = await control.delete();
            return hostResult(deleted, input.action);
          }
        }
      } catch (error) {
        return {
          success: false,
          action: input.action,
          error:
            error instanceof Error
              ? error.message
              : `Workspace ${input.action} failed`,
        };
      }
    },
  });
}
