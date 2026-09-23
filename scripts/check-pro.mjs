import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const client = new Client({ name: "pro-check", version: "1" });
try {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./start-pro-local.mjs", import.meta.url))], stderr: "pipe" });
  transport.stderr?.on("data", chunk => process.stderr.write(String(chunk).slice(0, 2000)));
  await client.connect(transport);
  const tools = await client.listTools();
  const reply = await client.callTool({ name: "continuity_pro_status", arguments: {} });
  const status = JSON.parse(reply.content[0].text);
  if (reply.isError || status.data?.codex_routing !== "disabled") throw new Error("Pro capability check failed");
  const read = await client.callTool({ name: "continuity_project_read", arguments: { project_id: "continuity", path: "src/main.ts", line_count: 2 } });
  const body = JSON.parse(read.content[0].text);
  if (read.isError || !body.data?.ok) throw new Error("Local source read failed");
  process.stdout.write(JSON.stringify({ local_stdio_verified: true, web_verified: false, tool_count: tools.tools.length, status: status.data, source_sha256: body.data.data.sha256 }, null, 2) + "\n");
} finally { await client.close(); }
