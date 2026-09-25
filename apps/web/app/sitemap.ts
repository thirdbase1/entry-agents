import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * sitemap.xml -- the crawlable, indexable surface of the marketing site.
 *
 * Deliberately limited to pages that render without a session: everything
 * under /sessions, /settings and the /[username] profile routes needs
 * auth or has unbounded URL space, and listing those would waste crawl
 * budget on pages Google cannot show. [username] profiles are still
 * reachable by links, just not enumerated here.
 *
 * `lastModified` on the root is the deploy time; marketing copy changes
 * with deploys, so re-validating on each build is the honest signal.
 */
const INDEXABLE_PATHS = [
  "/",
  "/pricing",
  "/model",
  "/benchmarks",
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return INDEXABLE_PATHS.map((path, index) => ({
    url: `${SITE_URL}${path}`,
    lastModified,
    // The homepage is the entry point; the rest sit one hop away, which is
    // exactly how we want crawl priority distributed.
    changeFrequency: index === 0 ? "weekly" : "monthly",
    priority: index === 0 ? 1 : 0.7,
  }));
}
