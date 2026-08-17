import { fetchModelCostCatalog } from "@/lib/models-with-context";

const CACHE_CONTROL = "private, no-store";

/**
 * Pricing-only model catalog for client-side cost estimation on usage
 * pages (settings/profile, settings/usage-section) -- deliberately NOT
 * filtered by admin-disabled/hard-blocked status, unlike /api/models.
 *
 * FIXED 2026-08-17: those pages used to reuse /api/models (the picker's
 * own filtered list) to price already-recorded usage_events client-side.
 * Once an admin disabled a model, it dropped out of that filtered list,
 * so any of that model's already-happened usage started rendering as
 * "unpriced" and its dollars vanished from the running total -- even
 * though the usage (and its debit against the user's credit balance)
 * had already happened before the model was disabled. See
 * fetchModelCostCatalog's own doc comment for the full story (this is
 * the same underlying bug that was fixed server-side in the admin usage
 * actions).
 */
export async function GET() {
  try {
    const models = await fetchModelCostCatalog();
    return Response.json(
      { models },
      { headers: { "Cache-Control": CACHE_CONTROL } },
    );
  } catch (error) {
    console.error("Failed to fetch model cost catalog:", error);
    return Response.json(
      { error: "Failed to fetch model cost catalog" },
      { status: 500 },
    );
  }
}
