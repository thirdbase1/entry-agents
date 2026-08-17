import type { AgentModelSelection } from "@open-agents/agent";
import { isModelDisabled } from "@/lib/model-availability";
import {
  sanitizeReasoningEffort,
  toReasoningProviderOptions,
} from "@/lib/model-reasoning";
import { toSafeChatError } from "@/lib/chat/friendly-error";
import { APP_DEFAULT_MODEL_ID } from "@/lib/models";

interface ResolveChatModelSelectionParams {
  selectedModelId: string | null | undefined;
  reasoningEffort?: string | null;
  missingModelLabel: string;
}

/**
 * Resolves a user's requested model into the concrete selection the agent
 * runtime should use.
 *
 * IMPORTANT -- no silent model substitution here. Owner instruction
 * (2026-08-17, after a user was silently and invisibly moved from
 * gpt-5.6-luna onto a disabled deepseek-v4-flash default and just saw
 * generic "something went wrong" errors with no idea why): if the model
 * the user actually picked is disabled/unavailable, throw a clear,
 * specific, user-facing error instead of quietly swapping in a different
 * model and only logging a console.warn nobody sees. The ONLY case that
 * still uses APP_DEFAULT_MODEL_ID is when no model was selected at all
 * (selectedModelId is null/undefined) -- that's an initial default, not a
 * failure-recovery fallback, so it's fine as long as the default itself
 * is a working model (see APP_DEFAULT_MODEL_ID's own definition).
 */
export async function resolveChatModelSelection({
  selectedModelId,
  reasoningEffort,
  missingModelLabel,
}: ResolveChatModelSelectionParams): Promise<AgentModelSelection> {
  const requestedModelId = selectedModelId ?? APP_DEFAULT_MODEL_ID;

  if (await isModelDisabled(requestedModelId)) {
    throw toSafeChatError(
      `${missingModelLabel} "${requestedModelId}" is currently unavailable. Please switch to a different model and try again.`,
    );
  }

  const effort = sanitizeReasoningEffort(requestedModelId, reasoningEffort);
  const providerOptionsOverrides = toReasoningProviderOptions(
    effort,
    requestedModelId,
  );

  return {
    id: requestedModelId as AgentModelSelection["id"],
    ...(providerOptionsOverrides ? { providerOptionsOverrides } : {}),
  };
}
