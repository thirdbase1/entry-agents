import "server-only";

/**
 * Live USD -> NGN conversion for Paystack checkout.
 *
 * Why this exists: this Paystack account (Nigerian merchant) only has
 * NGN enabled -- USD/other currencies return "unsupported_currency"
 * (confirmed against the live API). Entry's plan prices/credit ledger
 * are all denominated in USD cents (see lib/billing/plans.ts), so every
 * checkout needs a USD->NGN conversion at the moment of charge. This
 * rate must be live, not hardcoded, since NGN has historically moved
 * fast against the dollar.
 *
 * Source: exchangerate.host's free, no-key endpoint (falls back to
 * open.er-api.com if that's down). Cached in-memory for
 * FX_CACHE_TTL_MS so a burst of checkouts doesn't hammer either API,
 * while staying "real-time" for practical purposes (rates don't move
 * meaningfully minute to minute).
 */

const FX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedRate: { usdToNgn: number; fetchedAt: number } | null = null;

interface FxProvider {
  name: string;
  url: string;
  parse: (json: unknown) => number | null;
}

const PROVIDERS: FxProvider[] = [
  {
    name: "open.er-api.com",
    url: "https://open.er-api.com/v6/latest/USD",
    parse: (json) => {
      const rate = (json as { rates?: Record<string, number> })?.rates?.NGN;
      return typeof rate === "number" && rate > 0 ? rate : null;
    },
  },
  {
    name: "exchangerate.host",
    url: "https://api.exchangerate.host/latest?base=USD&symbols=NGN",
    parse: (json) => {
      const rate = (json as { rates?: Record<string, number> })?.rates?.NGN;
      return typeof rate === "number" && rate > 0 ? rate : null;
    },
  },
];

/** Hard fallback only if every live provider is unreachable -- logged loudly since it means pricing is stale. */
const EMERGENCY_FALLBACK_RATE = 1650;

async function fetchLiveRate(): Promise<number> {
  for (const provider of PROVIDERS) {
    try {
      const res = await fetch(provider.url, {
        signal: AbortSignal.timeout(4000),
        cache: "no-store",
      });
      if (!res.ok) {
        continue;
      }
      const json = await res.json();
      const rate = provider.parse(json);
      if (rate) {
        return rate;
      }
    } catch (error) {
      console.error(`[fx] Provider ${provider.name} failed:`, error);
    }
  }

  console.error(
    "[fx] All live USD->NGN providers failed -- using emergency fallback rate. Pricing may be stale, investigate ASAP.",
  );
  return EMERGENCY_FALLBACK_RATE;
}

/** Returns the current USD->NGN rate (1 USD = N NGN), refreshed at most every FX_CACHE_TTL_MS. */
export async function getUsdToNgnRate(): Promise<number> {
  const now = Date.now();
  if (cachedRate && now - cachedRate.fetchedAt < FX_CACHE_TTL_MS) {
    return cachedRate.usdToNgn;
  }

  const usdToNgn = await fetchLiveRate();
  cachedRate = { usdToNgn, fetchedAt: now };
  return usdToNgn;
}

/** Converts a USD-cents amount to NGN kobo (Paystack's smallest NGN unit) using the live rate. */
export async function usdCentsToNgnKobo(
  usdCents: number,
): Promise<{ ngnKobo: number; rate: number }> {
  const rate = await getUsdToNgnRate();
  const ngnKobo = Math.round(usdCents * rate);
  return { ngnKobo, rate };
}
