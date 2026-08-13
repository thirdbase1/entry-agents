import type { AgentModelSelection } from "@entry/agent";
import { resolveAvailableModelId } from "@/lib/model-availability";
import {
  sanitizeReasoningEffort,
  toReasoningProviderOptions,
} from "@/lib/model-reasoning";
import { APP_DEFAULT_MODEL_ID } from "@/lib/models";

interface ResolveChatModelSelectionParams {
  selectedModelId: string | null | undefined;
  reasoningEffort?: string | null;
  missingModelLabel: string;
}

export function resolveChatModelSelection({
  selectedModelId,
  reasoningEffort,
  missingModelLabel,
}: ResolveChatModelSelectionParams): AgentModelSelection {
  const requestedModelId = selectedModelId ?? APP_DEFAULT_MODEL_ID;

  const availableModelId = resolveAvailableModelId(requestedModelId);
  if (availableModelId !== requestedModelId) {
    console.warn(
      `${missingModelLabel} "${requestedModelId}" resolves to disabled model. Falling back to default model.`,
    );
    return { id: APP_DEFAULT_MODEL_ID as AgentModelSelection["id"] };
  }

  const effort = sanitizeReasoningEffort(availableModelId, reasoningEffort);
  const providerOptionsOverrides = toReasoningProviderOptions(effort);

  return {
    id: availableModelId as AgentModelSelection["id"],
    ...(providerOptionsOverrides
      ? { providerOptionsOverrides }
      : {}),
  };
}
