import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

// A real local stdio check. No tunnel, browser, model, credentials or writes.
const config = process.env.CONTINUITY_PROJECTS_CONFIG;
const args = process.argv.slice(2);
const readProject = args[0] === "--project" ? args[1] : undefined;
const readPath = args[2] === "--path" ? args[3] : undefined;
if (args.length && (args.length !== 4 || !readProject || !readPath)) {
  process.stderr.write("Usage: npm run reader:check [-- --project ID --path relative/file]\n");
  process.exit(1);
}
if (!config) {
  process.stderr.write("Set CONTINUITY_PROJECTS_CONFIG to your local projects JSON file.\n");
  process.exitCode = 1;
} else {
  const client = new Client({ name: "continuity-reader-check", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../dist/src/project-reader/mcp.js", import.meta.url))],
    env: { CONTINUITY_PROJECTS_CONFIG: config }, stderr: "pipe" });
  const timeout = setTimeout(() => { process.stderr.write("Local MCP check timed out.\n"); process.exit(1); }, 15_000);
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (tools.tools.length !== 4 || tools.tools.some((tool) => tool.annotations?.readOnlyHint !== true)) throw new Error("unexpected tools");
    const reply = await client.callTool({ name: "continuity_projects_list", arguments: {} });
    if (reply.isError) throw new Error("project list failed");
    const body = reply.structuredContent;
    const checks = [];
    for (const project of body.data.projects) {
      const files = await client.callTool({ name: "continuity_project_files", arguments: { project_id: project.project_id } });
      if (files.isError) throw new Error("project listing failed");
      checks.push({ project_id: project.project_id, visible_root_entries: files.structuredContent.data.entries.length, truncated: files.structuredContent.data.truncated });
    }
    let read = null;
    if (readProject && readPath) {
      const reply = await client.callTool({ name: "continuity_project_read", arguments: { project_id: readProject, path: readPath, line_count: 5 } });
      if (reply.isError) throw new Error("project read failed");
      const data = reply.structuredContent.data;
      read = { project_id: data.project_id, path: data.path, sha256: data.sha256, bytes: data.bytes, returned_lines: data.lines.length };
    }
    process.stdout.write(JSON.stringify({ ok: true, evidence: "LOCAL_MCP_STDIO", tools: tools.tools.map((tool) => tool.name), projects: checks, read, web_verified: false }, null, 2) + "\n");
  } catch {
    process.stderr.write("Local MCP check failed. Check the build, JSON configuration and project permissions.\n");
    process.exitCode = 1;
  } finally { clearTimeout(timeout); await client.close(); }
}
