/**
 * Single source of truth for the package's default/placeholder model id.
 *
 * Deliberately its own tiny module with zero imports: open-agent.ts (which
 * re-exports this for external consumers) is itself imported by
 * system-prompt.ts -> subagents/registry.ts -> subagents/executor.ts and
 * subagents/explorer.ts, so those two subagent files can't import
 * defaultModelLabel from "../open-agent" directly without creating an
 * import cycle. Importing it from here instead breaks the cycle while
 * still keeping one real source of truth.
 *
 * Changed 2026-08-17: was "deepseek-v4-flash", which got admin-disabled
 * the same day -- swapped to gpt-5.6-luna (the actual free-tier model,
 * see FREE_PLAN_MODEL_ID in apps/web/lib/billing/plans.ts) so this stays
 * a genuinely working default instead of pointing at a disabled model.
 *
 * Changed 2026-09-22: gpt-5.6-luna was retired as the free-tier model
 * (owner request) in favour of the ":free" gateway route
 * qwen3.8-flash:free, so this follows it. Keep in sync with
 * FREE_PLAN_MODEL_ID -- that constant is the real gate, this is only the
 * display/placeholder label.
 */
export const defaultModelLabel = "qwen3.8-flash:free" as const;
