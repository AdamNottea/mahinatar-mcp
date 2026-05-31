#!/usr/bin/env node
/**
 * mahinatar-mcp — Elite-tier MCP server connecting Claude Code to a Mahinatar
 * account for pipeline outreach.
 *
 * The server starts cleanly even with placeholder/missing credentials: auth is
 * lazy and only happens on the first tool call, so `node dist/index.js` always
 * comes up and lists tools. Auth/plan errors surface as clean tool-call errors.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerTools } from "./tools/index.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "mahinatar-mcp",
    version: "0.1.0",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout is the MCP stdio channel.
  console.error("mahinatar-mcp running (stdio). Outreach is DRY-RUN unless MAHINATAR_OUTREACH_LIVE=true + Resend configured.");
}

main().catch((e) => {
  console.error("Fatal: mahinatar-mcp failed to start:", e);
  process.exit(1);
});
