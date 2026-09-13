import { checkBotProtection } from "@/lib/botid";
import { generateText } from "ai";
import { gateway } from "@open-agents/agent";
import { z } from "zod";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getServerSession } from "@/lib/session/get-server-session";

/**
 * Model used for title generation. Owner request (2026-09-13): use
 * qwen3.8-flash (routed via api.b.ai through the gateway) -- title
 * generation is a tiny, low-stakes task, so it goes to a cheap, fast
 * model instead of burning the premium app-default model on a 5-word
 * string. Also decouples titles from the default model's fate: the app
 * default has gone through multiple outage/disable cycles (ling-3.0,
 * deepseek-v4-flash, gpt-5.6-luna, gpt-5.6-sol), and every time it did,
 * every new chat's title generation silently died with it.
 */
const TITLE_MODEL_ID = "qwen3.8-flash";

/**
 * Hard cap on the title-generation call. generateText has no timeout of
 * its own -- a slow or hung gateway/upstream call would otherwise pin a
 * serverless function slot until Vercel's 300s function timeout, and
 * enough of those stacked up (one fires on every new chat's first
 * message) can starve the app's limited serverless concurrency entirely.
 * On timeout the title just falls back to the client's optimistic
 * truncation of the user's message.
 */
const TITLE_GENERATION_TIMEOUT_MS = 15_000;

/**
 * Generates a short, descriptive session title from a user message using AI.
 *
 * Can be called directly as a POST endpoint or used internally via
 * `generateSessionTitle()` for non-blocking server-side usage.
 */
export async function generateSessionTitle(
  message: string,
): Promise<string | null> {
  const trimmed = message.trim().slice(0, 2000);
  if (trimmed.length === 0) return null;

  try {
    const result = await generateText({
      model: gateway(TITLE_MODEL_ID),
      abortSignal: AbortSignal.timeout(TITLE_GENERATION_TIMEOUT_MS),
      prompt: `You are a developer tool that names coding sessions. Generate a concise title (max 5 words) for a coding session based on the user's first message below. The title should help the user quickly identify what this session is about at a glance. Do NOT use quotes or punctuation around the title. Respond with ONLY the title, nothing else.

User message:
${trimmed}`,
    });

    const title = result.text.trim().split("\n")[0]?.trim();
    if (title && title.length > 0) {
      return title.slice(0, 60);
    }
    return null;
  } catch (error) {
    console.error("[generate-title] Failed to generate title:", error);
    return null;
  }
}

const generateTitleRequestSchema = z.object({
  message: z.string().trim().min(1),
});

export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const botVerification = await checkBotProtection();
  if (botVerification.isBot) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const limited = await checkRateLimit({
    key: rateLimitKey(["generate-title", session.user.id]),
    limit: 10,
    windowMs: 60_000,
  });
  if (limited) {
    return limited;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsedBody = generateTitleRequestSchema.safeParse(body);

  if (!parsedBody.success) {
    return Response.json(
      { error: "Missing required field: message" },
      { status: 400 },
    );
  }

  const { message } = parsedBody.data;

  const title = await generateSessionTitle(message);

  if (!title) {
    return Response.json(
      { error: "Failed to generate title" },
      { status: 500 },
    );
  }

  return Response.json({ title });
}
