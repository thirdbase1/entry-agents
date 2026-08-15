import type { AgentModelSelection } from "@open-agents/agent";
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

export async function resolveChatModelSelection({
  selectedModelId,
  reasoningEffort,
  missingModelLabel,
}: ResolveChatModelSelectionParams): Promise<AgentModelSelection> {
  const requestedModelId = selectedModelId ?? APP_DEFAULT_MODEL_ID;

  const availableModelId = await resolveAvailableModelId(requestedModelId);
  if (availableModelId !== requestedModelId) {
    console.warn(
      `${missingModelLabel} "${requestedModelId}" resolves to disabled model. Falling back to default model.`,
    );
    return { id: APP_DEFAULT_MODEL_ID as AgentModelSelection["id"] };
  }

  const effort = sanitizeReasoningEffort(availableModelId, reasoningEffort);
  const providerOptionsOverrides = toReasoningProviderOptions(
    effort,
    availableModelId,
  );

  return {
    id: availableModelId as AgentModelSelection["id"],
    ...(providerOptionsOverrides ? { providerOptionsOverrides } : {}),
  };
}
