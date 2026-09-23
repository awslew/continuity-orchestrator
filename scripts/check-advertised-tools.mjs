/** Report the tool list this server advertises, without touching the running tunnel.
 *
 * The live bridge holds the instance locks on its own state directories, so starting a
 * second server against the same config dies with INSTANCE_LOCKED. This script builds a
 * throwaway config that keeps every gate (editor, development, local_access, bridge)
 * from the real one but redirects all state paths into %TEMP%, so it can be run at any
 * time — including while ChatGPT is connected — and it is the authoritative answer to
 * "what schema is a fresh client given when it refreshes its tools?".
 *
 * Usage: node scripts/check-advertised-tools.mjs [config/pro.local.json]
 */
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const source = resolve(process.argv[2] ?? "config/pro.local.json");
const config = JSON.parse(await readFile(source, "utf8"));
const scratch = await mkdtemp(join(tmpdir(), "advertised-tools-"));
// Same gates, isolated state: this is about the advertised schema, not about state.
if (config.editor) config.editor.state_dir = join(scratch, "editor");
if (config.local_access) config.local_access.state_dir = join(scratch, "local");
if (config.bridge) {
  const workspaces = resolve(config.bridge.workspaces_config);
  config.bridge.workspaces_config = join(scratch, "workspaces.json");
  await writeFile(config.bridge.workspaces_config, await readFile(workspaces, "utf8"));
}
const configPath = join(scratch, "pro.json");
await writeFile(configPath, JSON.stringify(config));

const client = new Client({ name: "advertised-tools", version: "1" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/src/project-reader/pro.js")],
  env: { ...process.env, CONTINUITY_PRO_CONFIG: configPath },
  stderr: "ignore"
}));
const tools = (await client.listTools()).tools;
const properties = (name, throughArrayItem = false) => {
  let node = tools.find(t => t.name === name)?.inputSchema;
  if (throughArrayItem) node = node?.properties?.changes?.items;
  return Object.keys(node?.properties ?? {});
};
console.log(JSON.stringify({
  config_source: source,
  tool_count: tools.length,
  tools: tools.map(t => ({ name: t.name, read_only: t.annotations?.readOnlyHint ?? null })),
  continuity_local_read_parameters: properties("continuity_local_read"),
  continuity_local_develop_parameters: properties("continuity_local_develop"),
  change_parameters: properties("continuity_local_develop", true),
  continuity_local_result_wait_maximum: tools.find(t => t.name === "continuity_local_result")?.inputSchema?.properties?.wait_seconds?.maximum ?? null,
  validation_timeout_maximum: tools.find(t => t.name === "continuity_local_develop")?.inputSchema?.properties?.validation?.items?.properties?.timeout_seconds?.maximum ?? null,
  advertised_additional_properties: tools.find(t => t.name === "continuity_local_develop")?.inputSchema?.additionalProperties ?? null
}, null, 2));
await client.close();
await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
