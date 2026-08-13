import { tool } from "ai";
import { z } from "zod";

// Runs server-side (in the Vercel function, not in the user's sandbox) so
// PARALLEL_API_KEY never touches the sandbox filesystem/env or an
// agent-composed curl command -- unlike web_fetch, which shells out inside
// the sandbox, this calls out directly from here. The key is a single
// shared credential owned by the app (like the shared model provider
// keys), not a per-user secret, so it must never appear in agent-visible
// text (SKILL.md, tool-call args, sandbox env) since sandboxes/skills are
// world-readable within a session and this repo is public.
const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";
const TIMEOUT_MS = 15_000;
const MAX_EXCERPT_CHARS = 500;
const MAX_RESULTS = 8;

const searchInputSchema = z.object({
  queries: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe(
      "1-3 concise keyword search queries (3-6 words each). Provide 2-3 for best results.",
    ),
  objective: z
    .string()
    .optional()
    .describe(
      "Natural-language description of what you're trying to find out. Helps the search engine focus on relevant content.",
    ),
});

const searchResultSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  publish_date: z.string().nullable(),
  excerpts: z.array(z.string()),
});

const searchOutputSchema = z.union([
  z.object({
    success: z.literal(true),
    results: z.array(searchResultSchema),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

export const webSearchTool = tool({
  description: `Search the public web and get back ranked results with title, URL, publish date, and relevant excerpts.

USAGE:
- Use for anything needing current information, a documentation page, or research outside your training data.
- Provide 1-3 concise search queries (3-6 words each) and, ideally, an objective describing what you're trying to find.
- Returns up to ${MAX_RESULTS} ranked results with short excerpts -- read a result's full page with web_fetch or agent-browser if the excerpt isn't enough.`,
  inputSchema: searchInputSchema,
  outputSchema: searchOutputSchema,
  execute: async ({ queries, objective }, { abortSignal }) => {
    const apiKey = process.env.PARALLEL_API_KEY;
    if (!apiKey) {
      return {
        success: false as const,
        error: "Web search is not configured (missing PARALLEL_API_KEY).",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const signal = abortSignal
      ? AbortSignal.any([abortSignal, controller.signal])
      : controller.signal;

    try {
      const response = await fetch(PARALLEL_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          search_queries: queries,
          objective: objective ?? null,
          mode: "fast",
          max_chars_total: MAX_RESULTS * MAX_EXCERPT_CHARS,
        }),
        signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        return {
          success: false as const,
          error: `Search failed (HTTP ${response.status}): ${bodyText.slice(0, 300)}`,
        };
      }

      const data = (await response.json()) as {
        results?: Array<{
          url: string;
          title?: string | null;
          publish_date?: string | null;
          excerpts?: string[];
        }>;
      };

      const results = (data.results ?? [])
        .slice(0, MAX_RESULTS)
        .map((result) => ({
          url: result.url,
          title: result.title ?? null,
          publish_date: result.publish_date ?? null,
          excerpts: (result.excerpts ?? []).map((excerpt) =>
            excerpt.length > MAX_EXCERPT_CHARS
              ? `${excerpt.slice(0, MAX_EXCERPT_CHARS)}…`
              : excerpt,
          ),
        }));

      return { success: true as const, results };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false as const,
        error: `Search failed: ${message}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
