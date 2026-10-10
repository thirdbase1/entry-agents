import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * robots.txt for entry-agents.dev.
 *
 * Marketing pages are fully open. The authenticated product surface
 * (session UI, settings, admin, API) is disallowed: it is behind auth,
 * so it can only ever produce soft-404s and dilute the pages we do
 * want indexed.
 *
 * GEO: AI answer engines are explicitly welcomed. Citation/search bots
 * (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot) and
 * training crawlers (GPTBot, ClaudeBot, Google-Extended, CCBot) all
 * get the same allow rules spelled out per-agent, so being quoted by
 * ChatGPT, Perplexity and AI Overviews does not depend on the default
 * `*` rule being interpreted generously. Nothing is blocked — the
 * whole point is AI visibility.
 */
const MARKETING_RULES = {
  allow: "/",
  disallow: [
    "/api/",
    "/admin/",
    "/settings/",
    "/sessions/",
    // Remaining auth-gated surfaces: billing (its public catalog lives at
    // /pricing), the codespace session view, and the desktop approve flow.
    "/billing/",
    "/codespace/",
    "/desktop/",
    "/_next/",
  ],
};

const AI_CRAWLERS = [
  // Real-time citation/search bots
  "OAI-SearchBot",
  "ChatGPT-User",
  "PerplexityBot",
  "Claude-SearchBot",
  // Training crawlers
  "GPTBot",
  "ClaudeBot",
  "Google-Extended",
  "CCBot",
  "Bytespider",
] as const;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        ...MARKETING_RULES,
      },
      ...AI_CRAWLERS.map((userAgent) => ({
        userAgent,
        ...MARKETING_RULES,
      })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
