/**
 * Single source of truth for rendering money in the UI.
 *
 * Before this existed, every surface carried its own hand-rolled formatter
 * (nine copies across the admin, settings, pricing and sidebar views).
 * The disagreements were real, if narrow: two of them dropped the cents
 * column entirely on whole-dollar balances, rendering a 1000-cent balance
 * as "$10" instead of "$10.00" and reading as rounded when it was exact;
 * and the `toFixed` copies skipped thousands grouping, so a 123456-cent
 * balance rendered "$1234.56" on the pricing page and admin lookup but
 * "$1,234.56" in the sidebar. Same number, different answer depending on
 * which page you happened to stand on.
 *
 * Two entry points, because the codebase genuinely holds money in two
 * units and confusing them is the expensive bug:
 *
 *   formatUsdCents(cents) -- ledger/balance values. Integer cents, as
 *     stored in `users.creditBalanceCents` and `credit_transactions`.
 *   formatUsd(dollars)   -- catalog-per-model cost estimates, which
 *     `estimateModelUsageCost` returns as USD.
 *
 * Keep the two apart: passing a cents value to formatUsd (or vice versa)
 * is off by 100x and will display as a plausible-looking wrong number.
 */

/**
 * Guard: a non-finite value (NaN from a bad DB read, Infinity from a
 * division blowup) would otherwise render literally as "$NaN" in the
 * sidebar. Coerce to zero so the UI degrades to an honest $0.00.
 */
function isRenderable(amount: number): boolean {
  return Number.isFinite(amount);
}

/**
 * Formats an amount held in USD cents.
 *
 * `minimumFractionDigits: 2` always, so 100 cents renders "$1.00" rather
 * than "$1" -- a balance that quietly loses its cents column reads as
 * rounded when it is exact, which is exactly backwards.
 */
export function formatUsdCents(cents: number): string {
  if (!isRenderable(cents)) {
    return "$0.00";
  }
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Formats an amount held in USD (not cents).
 *
 * Below one dollar the value is typically a per-message model cost, where
 * two decimals erase most of the signal: $0.004 and $0.00 are the same
 * string. Four decimals there keeps sub-cent costs legible, matching what
 * the message model pill already showed.
 */
export function formatUsd(dollars: number): string {
  if (!isRenderable(dollars)) {
    return "$0.00";
  }
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: dollars > 0 && dollars < 1 ? 4 : 2,
    maximumFractionDigits: dollars > 0 && dollars < 1 ? 4 : 2,
  })}`;
}
