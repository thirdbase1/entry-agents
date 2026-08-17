import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const auth = req.headers.get("x-verify-secret");
  if (auth !== "verify_pricing_9f3a7c2e1b") {
    return NextResponse.json({ error: "nope" }, { status: 401 });
  }
  const baseURL = process.env.GATEWAY_BASE_URL!;
  const apiKey = process.env.GATEWAY_API_KEY!;
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/debug/routes`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await res.text();
  return new NextResponse(text, { status: res.status });
}
