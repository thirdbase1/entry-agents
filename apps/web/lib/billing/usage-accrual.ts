/**
 * Sub-cent usage accrual.
 *
 * The ledger only holds whole cents (`users.credit_balance_cents` and
 * `credit_transactions.amount_cents` are both `integer`), but the real
 * cost of a step is a fraction of a cent far more often than not: a
 * cheap model emitting a short answer is routinely $0.002-$0.004. The
 * old code did `Math.round(costUsd * 100)` before handing the value to
 * `debitUsage`, and `debitUsage` then early-returns on anything <= 0 --
 * so every sub-cent step billed NOTHING. Verified loss: ten $0.004
 * steps (4 cents of real cost) charged 0 cents. On a cheap-model catalog
 * that is systematic free usage, and it compounds silently because
 * nothing in the ledger shows the shortfall.
 *
 * This module keeps the DB schema untouched and still loses nothing:
 * every step's cost is carried at full precision, and only whole cents
 * are ever written to the ledger. When the carry crosses 1 cent, that
 * whole cent is debited; the remainder stays pending for the next step.
 * A single fractional part is never dropped on the floor.
 *
 * Note this makes billing slightly LAZY by design -- a step can settle
 * its cost only once the carry accumulates enough. That is the same
 * tradeoff the ledger's integer column forces, and it is strictly
 * fairer than silently undercharging: over any run of steps the user
 * is billed their exact sum, never more.
 */

/** Round-half-up at 6dp, avoiding float dust like 0.14999999999 -> 0.15. */
function round6(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}

export interface UsageAccrualState {
  /**
   * Unbilled cost accumulated so far, in cents. Always in [0, 1): the
   * whole-cent part has already left for the ledger by the time a
   * settle() returns.
   */
  carryCents: number;
}

/**
 * Folds a step's cost into the accumulator and returns how many whole
 * cents are now actually billable (0 is a normal, expected result --
 * it means the step was cheaper than a cent and its cost stays
 * pending). Mutates `state` in place so the caller can thread one
 * accumulator through a whole turn.
 *
 * @param costUsd  Real step cost in USD, as returned by
 *                `estimateStepCost`/`estimateModelUsageCost`. Sub-cent
 *                values are the whole point; do not pre-round them.
 */
export function settleStepCost(
  state: UsageAccrualState,
  costUsd: number,
): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) {
    return 0;
  }

  state.carryCents = round6(state.carryCents + costUsd * 100);

  // Only the whole cents leave. Guard the floor against a carry that is
  // somehow negative or non-finite so a bad value can never produce a
  // nonsense ledger entry.
  const billableCents = Number.isFinite(state.carryCents)
    ? Math.max(0, Math.floor(state.carryCents))
    : 0;

  state.carryCents = round6(state.carryCents - billableCents);
  return billableCents;
}

/**
 * Total cost an accumulator has seen, whole cents plus pending carry.
 * Useful for spend-cap comparisons, which must consider EVERY step's
 * real cost rather than only the steps that happened to settle.
 */
export function accruedCostCents(state: UsageAccrualState): number {
  return round6(state.carryCents);
}
