export const dynamic = "force-dynamic";

/** Health probe: confirms Project-B is deployed and booted. No secrets. */
export function GET() {
  return Response.json({
    ok: true,
    service: "entry-desktop-backend",
    source: "apps/desktop-backend (Phase 7)",
  });
}
