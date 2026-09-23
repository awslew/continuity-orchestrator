// One-time onboarding. Does not execute project code, switch the live service,
// change credentials or initialize/commit the user's repository.
import { mkdir, readFile, writeFile, realpath, access } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { proConfigSchema } from '../dist/src/project-reader/pro.js';
const [input, validationFile] = process.argv.slice(2);
if (!input) throw new Error('Usage: node scripts/setup-pro-project.mjs <project-directory> [validation-steps.json]');
const root = await realpath(resolve(input));
const app = fileURLToPath(new URL('..', import.meta.url));
const id = (basename(root).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50) || 'project') + '-' + createHash('sha256').update(root).digest('hex').slice(0, 8);
let validation;
if (validationFile) validation = JSON.parse(await readFile(resolve(validationFile), 'utf8'));
else {
  let pkg;
  try { pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!pkg || !pkg.scripts?.test || pkg.scripts.test.includes('no test specified')) throw new Error('No reliable test script detected. Supply validation-steps.json once; no fake PASS command will be generated.');
  const candidates = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(dirname(process.execPath)), 'lib/node_modules/npm/bin/npm-cli.js')];
  let npm;
  for (const path of candidates) { try { await access(path); npm = path; break; } catch {} }
  if (!npm) throw new Error('Could not locate npm-cli.js; supply explicit validation steps.');
  validation = [];
  if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) {
    await access(join(root, 'package-lock.json')).catch(() => { throw new Error('Dependencies require package-lock.json for reproducible npm ci in the snapshot. Supply explicit steps for another package manager.'); });
    validation.push({ name: 'Install locked dependencies in snapshot', argv: [process.execPath, npm, 'ci', '--no-audit', '--no-fund'], timeout_seconds: 300 });
  }
  if (pkg.scripts.build) validation.push({ name: 'Build in snapshot', argv: [process.execPath, npm, 'run', 'build'], timeout_seconds: 300 });
  validation.push({ name: 'Project tests in snapshot', argv: [process.execPath, npm, 'test'], timeout_seconds: 300 });
}
const stateParent = resolve(app, '../pro-project-state');
await mkdir(stateParent, { recursive: true });
const config = proConfigSchema.parse({ version: 1, reader: { version: 1, projects: [{ id, name: basename(root), root, share: ['.'] }] },
  editor: { state_dir: join(stateParent, id), workspaces: [{ project_id: id, writable_paths: ['.'], validation }] },
  development: { default_project: id, auto_apply: true } });
const output = join(app, 'config', `${id}.local.json`);
await writeFile(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ config: output, project_id: id, registered: true, activated: false,
  next: `powershell -File scripts/manage-pro-tunnel.ps1 start -Config "${output}"`,
  note: 'Stop the currently running config first. Refresh ChatGPT plugin tools once. Source permissions and auto-apply are enabled; hidden/private/binary files remain excluded. Dependency/test commands execute local project code. Real acceptance must still pass.' }, null, 2));
