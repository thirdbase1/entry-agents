import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * robots.txt for entry-agents.dev.
 *
 * The site had no robots.txt and no sitemap at all (verified before this
 * file existed: no match for robots|sitemap|canonical|ld+json anywhere in
 * apps/web), so crawlers were being given nothing to work with.
 *
 * Marketing pages are fully open. The authenticated product surface
 * (session UI, settings, admin, API) is disallowed: it is behind auth, so
 * it can only ever produce soft-404s and dilute the pages we do want
 * indexed.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/admin/", "/settings/", "/sessions/", "/_next/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
