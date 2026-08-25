import {
  createMcpServer,
  InvalidMcpServerNameError,
  listMcpServers,
} from "@/lib/db/mcp-servers";
import { UnsafeMcpServerUrlError } from "@/lib/mcp/url-safety";
import { getServerSession } from "@/lib/session/get-server-session";

interface CreateMcpServerRequest {
  name?: string;
  transport?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
}

export async function GET() {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const servers = await listMcpServers(session.user.id);
  return Response.json({ servers });
}

export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: CreateMcpServerRequest;
  try {
    body = (await req.json()) as CreateMcpServerRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  if (body.transport !== "http" && body.transport !== "sse") {
    return Response.json(
      { error: 'transport must be "http" or "sse"' },
      { status: 400 },
    );
  }

  if (typeof body.url !== "string" || body.url.trim().length === 0) {
    return Response.json({ error: "url is required" }, { status: 400 });
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

  try {
    const created = await createMcpServer({
      userId: session.user.id,
      name: body.name.trim(),
      transport: body.transport,
      url: body.url.trim(),
      headers: body.headers,
    });
    return Response.json({ server: created }, { status: 201 });
  } catch (error) {
    if (
      error instanceof InvalidMcpServerNameError ||
      error instanceof UnsafeMcpServerUrlError
    ) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof Error &&
      error.message.includes("mcp_servers_user_id_name_idx")
    ) {
      return Response.json(
        { error: "You already have a server with this name" },
        { status: 409 },
      );
    }
    console.error("Failed to create MCP server:", error);
    return Response.json(
      { error: "Failed to create MCP server" },
      { status: 500 },
    );
  }
}
