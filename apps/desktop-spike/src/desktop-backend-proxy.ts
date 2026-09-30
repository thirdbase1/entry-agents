/**
 * Phase 6 — Desktop Backend route allowlist (Step 7) + model proxy (Step 8).
 *
 * The Desktop Backend is a separately-deployed apps/web instance. To avoid
 * exposing the whole web backend to desktop clients, desktop traffic is
 * restricted to an explicit allowlist of routes. This module is the single
 * canonical allowlist definition (inspect-only here; when apps/web is
 * deployed as Project B, its middleware consults this shape).
 *
 * Allowlisted capabilities (from the real apps/web route inventory):
 *   - POST /api/auth/*        better-auth session exchange/refresh
 *   - POST /api/chat          chat persistence + streaming turn (web Workflow
 *                             path stays WEB-ONLY; desktop uses its local
 *                             agent — desktop persistence reuses lib/db
 *                             session functions, NOT /api/chat)
 *   - GET  /api/models        model catalog for the picker
 *   - GET  /api/usage         usage/account state
 *   - POST /api/desktop/v1/*  model/Gateway proxy (new, desktop-only):
 *                             authenticated → forwards to Entry Gateway with
 *                             the server-side GATEWAY_API_KEY. Streaming,
 *                             abort, usage metadata pass through; the key
 *                             never appears in a response.
 * Everything else → 403 (fail closed).
 */

/**
 * Phase 7 — Desktop Backend route allowlist (updated for the deployed
 * Project-B: https://entry-project-b.vercel.app, source apps/desktop-backend).
 * Route exposure is restricted to the actual Project-B surface; everything
 * else fails closed.
 */

export const DESKTOP_BACKEND_ALLOWED_ROUTES: Array<{
  method: string;
  pattern: RegExp;
  capability: string;
}> = [
  { method: "GET", pattern: /^\/api\/desktop\/health\/?$/, capability: "health" },
  { method: "GET", pattern: /^\/api\/desktop\/models\/?$/, capability: "model catalog" },
  { method: "POST", pattern: /^\/api\/desktop\/chat\/?$/, capability: "model/Gateway proxy" },
  { method: "POST", pattern: /^\/api\/desktop\/chats\/?$/, capability: "chat persistence" },
  { method: "GET", pattern: /^\/api\/desktop\/chats\/[^/]+\/?$/, capability: "chat read" },
  { method: "POST", pattern: /^\/api\/desktop\/chats\/[^/]+\/messages\/?$/, capability: "chat append" },
  { method: "POST", pattern: /^\/api\/desktop\/usage\/?$/, capability: "usage reporting" },
];

/** Fail-closed check. Sessions/chats/usage business logic is reused from
 * lib/db — only ROUTE exposure is restricted, never duplicated. */
export function isAllowedDesktopRoute(method: string, pathname: string): boolean {
  return DESKTOP_BACKEND_ALLOWED_ROUTES.some(
    (r) => r.method === method && r.pattern.test(pathname),
  );
}

/**
 * Minimal Desktop Backend model proxy (Step 8). Stands in for the deployed
 * route handler: authenticates the desktop session, forwards the OpenAI-
 * compatible request body to the Entry Gateway with the server-side key,
 * and streams the response back untouched. Never logs or returns the key.
 */
export function createDesktopModelProxy(options: {
  gatewayBaseURL: string;
  gatewayApiKey: string;
  /** Validates the desktop session token → userId (lib/db sessions lookup on the real deployment). */
  authenticate: (sessionToken: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async function handleModelProxy(req: Request): Promise<Response> {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const userId = await options.authenticate(token);
    if (!userId) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }

    const upstreamHeaders: Record<string, string> = {
      "content-type": req.headers.get("content-type") ?? "application/json",
      authorization: `Bearer ${options.gatewayApiKey}`,
      "x-desktop-user-id": userId,
    };
    // Drop hop-by-hop/credential headers; never forward client auth upstream.
    for (const h of ["cookie", "x-desktop-session-token"]) {
      upstreamHeaders[h] = undefined as never;
    }

    const upstream = await fetchImpl(`${options.gatewayBaseURL}/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders,
      body: await req.text(),
      // Propagate client aborts (Stop button) to the Gateway request.
      signal: req.signal,
    });

    const headers = new Headers();
    for (const h of ["content-type", "transfer-encoding"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    // usage metadata / request ids / cache info ride the SSE stream body —
    // forwarded untouched. The Gateway key is not part of the response.
    return new Response(upstream.body, { status: upstream.status, headers });
  };
}
