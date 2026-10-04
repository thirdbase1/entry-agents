import { NextRequest, NextResponse } from "next/server";
import { requireDesktopUser, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /v1/chat/completions — Entry Gateway proxy (desktop model transport) with the SERVER-SIDE
 * GATEWAY_API_KEY. Streams the gateway's response straight through
 * (SSE-friendly), propagates client aborts, and never returns the key.
 * The agent itself runs locally in Electron — this is only the model
 * transport boundary (Phase 5/6 architecture, now deployed).
 */
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const user = await requireDesktopUser(req);
  if (!user) return unauthorized();

  const gatewayBase = process.env.GATEWAY_BASE_URL;
  const gatewayKey = process.env.GATEWAY_API_KEY;
  if (!gatewayBase || !gatewayKey) {
    return NextResponse.json({ error: "Model gateway unavailable" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${gatewayBase.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gatewayKey}`,
        "http-referer": process.env.NEXT_PUBLIC_SITE_URL ?? "https://entry-agents.dev",
        "x-title": "Entry Desktop",
      },
      body: JSON.stringify(body),
      signal: req.signal, // propagate desktop cancellation
    });
  } catch {
    return NextResponse.json({ error: "Model gateway unreachable" }, { status: 504 });
  }

  if (!upstream.ok) {
    const status = upstream.status;
    return NextResponse.json(
      {
        error:
          status === 401 || status === 403
            ? "Model gateway rejected the request"
            : `Model error (${status})`,
      },
      { status: status >= 500 ? 502 : 400 },
    );
  }

  // Stream the body through untouched (usage metadata, request ids and
  // cache info ride inside the SSE payload). The key is not in the response.
  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  return new Response(upstream.body, { status: upstream.status, headers });
}
