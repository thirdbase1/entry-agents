import { getRun } from "workflow/api";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const runIds = Array.isArray(body?.runIds) ? body.runIds : [];
  const results = [];
  for (const runId of runIds) {
    try {
      await getRun(String(runId)).cancel();
      results.push({ runId, cancelled: true });
    } catch (error) {
      results.push({ runId, cancelled: false, error: String(error) });
    }
  }
  return Response.json({ results });
}
