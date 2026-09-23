// Read-only configuration diagnostics. Never starts a worker or executes tests.
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proConfigSchema } from '../dist/src/project-reader/pro.js';
import { ProjectReader } from '../dist/src/project-reader/service.js';
const path = resolve(process.argv[2] ?? fileURLToPath(new URL('../config/pro.local.json', import.meta.url)));
const checks = [];
async function check(name, fn) { try { checks.push({ name, ok: true, details: await fn() }); } catch (e) { checks.push({ name, ok: false, error: e.code ?? e.message }); } }
let config;
await check('configuration', async () => { config = proConfigSchema.parse(JSON.parse(await readFile(path, 'utf8'))); return { config_path: path }; });
if (config) {
  await check('reader', async () => (await ProjectReader.create(config.reader)).listProjects());
  if (config.bridge) {
    await check('bridge_build', async () => { await access(config.bridge.entry); return { entry: config.bridge.entry }; });
    await check('bridge_workspaces', async () => {
      const entries = JSON.parse(await readFile(config.bridge.workspaces_config, 'utf8'));
      if (entries.length !== config.bridge.workspace_ids.length || config.bridge.workspace_ids.some(id => !entries.some(e => e.id === id))) throw new Error('Workspace scope mismatch');
      return { workspaces: entries.map(e => ({ id: e.id, root: e.root, allow_write: e.allow_write ?? false })), worker_enabled: config.bridge.allow_workers, dsh_home_configured: !!config.bridge.dsh_home };
    });
  }
  if (config.editor) {
    await check('editor_state_parent', async () => { const parent = await realpath(dirname(config.editor.state_dir)); return { parent, state_dir: config.editor.state_dir }; });
    for (const workspace of config.editor.workspaces) {
      await check(`editor:${workspace.project_id}`, async () => {
        const p = config.reader.projects.find(p => p.id === workspace.project_id);
        if (!p) throw new Error('Unregistered project');
        return { writable_paths: workspace.writable_paths, git_required: false, commands: await Promise.all(workspace.validation.map(async step => {
          const exe = step.argv[0];
          const bases = isAbsolute(exe) ? [exe] : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(dir => join(dir, exe));
          const candidates = process.platform === 'win32' ? bases.flatMap(p => [p, p + '.exe']) : bases;
          let found = null;
          for (const candidate of candidates) { try { if ((await lstat(candidate)).isFile() && !/\.(cmd|bat|ps1)$/i.test(candidate)) { found = candidate; break; } } catch {} }
          if (!found) throw new Error(`Validation executable unavailable: ${step.name}; use a directly executable binary, or node with a CLI .js path`);
          return { name: step.name, executable: found, timeout_seconds: step.timeout_seconds };
        })) };
      });
    }
  }
}
console.log(JSON.stringify({ static_checks_passed: checks.every(c => c.ok), checks, web_verified: false, worker_verified: false, note: 'Read-only local checks only. Server activation performs additional scope and lease checks; run the documented integration and web acceptance separately.' }, null, 2));
if (checks.some(c => !c.ok)) process.exitCode = 1;
