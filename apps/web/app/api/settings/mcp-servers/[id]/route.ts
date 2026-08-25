import {
  deleteMcpServer,
  InvalidMcpServerNameError,
  updateMcpServer,
} from "@/lib/db/mcp-servers";
import { UnsafeMcpServerUrlError } from "@/lib/mcp/url-safety";
import { getServerSession } from "@/lib/session/get-server-session";

interface UpdateMcpServerRequest {
  name?: string;
  transport?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;

  let body: UpdateMcpServerRequest;
  try {
    body = (await req.json()) as UpdateMcpServerRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    body.transport !== undefined &&
    body.transport !== "http" &&
    body.transport !== "sse"
  ) {
    return Response.json(
      { error: 'transport must be "http" or "sse"' },
      { status: 400 },
    );
  }

  if (
    body.headers !== undefined &&
    (typeof body.headers !== "object" ||
      body.headers === null ||
      Object.values(body.headers).some((v) => typeof v !== "string"))
  ) {
    return Response.json(
      { error: "headers must be a string-to-string map" },
      { status: 400 },
    );
  }

  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return Response.json(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }

  try {
    const updated = await updateMcpServer({
      userId: session.user.id,
      id,
      name: body.name?.trim(),
      transport: body.transport,
      url: body.url?.trim(),
      headers: body.headers,
      enabled: body.enabled,
    });

    if (!updated) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return Response.json({ server: updated });
  } catch (error) {
    if (
      error instanceof InvalidMcpServerNameError ||
      error instanceof UnsafeMcpServerUrlError
    ) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("Failed to update MCP server:", error);
    return Response.json(
      { error: "Failed to update MCP server" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;
  const deleted = await deleteMcpServer(session.user.id, id);

  if (!deleted) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
