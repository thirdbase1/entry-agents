import { APP_DEFAULT_MODEL_ID } from "@/lib/models";
import { getDisabledModelIdSet } from "@/lib/db/model-overrides";

const DISABLED_OPENAI_GPT_PREFIX = "openai/gpt-";
const DISABLED_OPENAI_PRO_SUFFIX = "-pro";

// Owner standing instruction: hide any "Mythos" model entirely from the
// picker, regardless of which upstream provider routes it. This is a
// hard, code-level block -- NOT exposed as a toggle on the admin models
// page, since the owner wants it always hidden regardless of who's
// looking at the admin page.
const DISABLED_NAME_SUBSTRINGS = ["mythos"];

// kimi-k3 and grok-4.5 are routed via Opencode Zen but that workspace has
// no payment method on file, so real requests to either one fail with a
// CreditsError. Hidden from the picker until billing is fixed upstream --
// remove from this list (or just delete the list) once that's resolved.
// (Both are correctly priced in entry-gateway's MODEL_ROUTES_JSON already,
// using Zen's own published rate card, so no further pricing work is
// needed once billing is fixed -- just delete them from this list.)
const DISABLED_MODEL_IDS = ["kimi-k3", "grok-4.5"];

/**
 * True if a model is hard-blocked in code (billing issue, banned brand
 * name, etc.) -- these are NOT admin-togglable, they need a code change
 * to lift. See isModelAdminDisabled for the DB-backed, instantly
 * togglable kill switch (the admin models page).
 */
export function isModelHardBlocked(modelId: string): boolean {
  const lowerId = modelId.toLowerCase();

  if (
    modelId.startsWith(DISABLED_OPENAI_GPT_PREFIX) &&
    modelId.endsWith(DISABLED_OPENAI_PRO_SUFFIX)
  ) {
    return true;
  }

  if (DISABLED_MODEL_IDS.includes(modelId)) {
    return true;
  }

  return DISABLED_NAME_SUBSTRINGS.some((substring) =>
    lowerId.includes(substring),
  );
}

/**
 * True if a model is disabled for any reason -- either hard-blocked in
 * code, or turned off by an admin via the DB-backed override table (the
 * /settings/admin/models page). This is the check every real call site
 * should use.
 */
export async function isModelDisabled(modelId: string): Promise<boolean> {
  if (isModelHardBlocked(modelId)) {
    return true;
  }

  const disabledIds = await getDisabledModelIdSet();
  return disabledIds.has(modelId);
}

export async function filterDisabledModels<T extends { id: string }>(
  models: T[],
): Promise<T[]> {
  const disabledIds = await getDisabledModelIdSet();
  return models.filter(
    (model) => !isModelHardBlocked(model.id) && !disabledIds.has(model.id),
  );
}

export async function resolveAvailableModelId(
  modelId: string,
): Promise<string> {
  if (await isModelDisabled(modelId)) {
    return APP_DEFAULT_MODEL_ID;
  }

  return modelId;
}
