import { McpServersSectionSkeleton } from "../mcp-servers-section";

export default function Loading() {
  return (
    <>
      <h1 className="text-2xl font-semibold">MCP Servers</h1>
      <McpServersSectionSkeleton />
    </>
  );
}
