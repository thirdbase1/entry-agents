/**
 * The one canonical origin for the product.
 *
 * Everything user-visible (profile share text, OG image footer, "back to
 * site" links, structured data) resolves here instead of embedding a host
 * in each component -- that is exactly how `entry-agents.vercel.app`
 * survived in three places after entry-agents.dev became the production
 * domain.
 *
 * `NEXT_PUBLIC_SITE_URL` wins so a self-hosted or forked deployment can
 * override it; otherwise Vercel's own production-domain variable is used,
 * and the literal is only the last-resort fallback (mirrors the metadata
 * fallback in app/layout.tsx).
 */
function resolveSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (production) {
    return `https://${production}`;
  }

  return "https://entry-agents.dev";
}

export const SITE_URL = resolveSiteUrl();

/** Host without `www` -- for compact display strings like `entry-agents.dev`. */
export const SITE_DOMAIN = new URL(SITE_URL).hostname.replace(/^www\./, "");

/** `https://<host>` with no trailing slash, safe to prefix a path onto. */
export const SITE_ORIGIN = new URL(SITE_URL).origin;
