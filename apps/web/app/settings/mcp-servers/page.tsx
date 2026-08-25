import type { Metadata } from "next";
import { McpServersSection } from "../mcp-servers-section";

export const metadata: Metadata = {
  title: "MCP Servers",
  description: "Connect external MCP servers to extend the agent's tools.",
};

export default function McpServersPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">MCP Servers</h1>
      <McpServersSection />
    </>
  );
}
