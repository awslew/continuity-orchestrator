// Local service startup preflight, after the manager has confirmed it is stopped.
// Never replays edits or recovers unknown writes; archived leases remain auditable.
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { proConfigSchema } from '../dist/src/project-reader/pro.js';
import { ProState } from '../dist/src/project-reader/pro-state.js';
import { ProjectEditor } from '../dist/src/project-reader/editor.js';
const config = proConfigSchema.parse(JSON.parse(await readFile(process.argv[2], 'utf8')));
if (config.bridge) {
  const entries = JSON.parse(await readFile(config.bridge.workspaces_config, 'utf8'));
  const state = await ProState.acquire(config.bridge.workspaces_config + '.pro-state.json', { bridge: config.bridge, entries }, entries.map(e => e.root), { recoverIdleOwner: true });
  await state.close();
}
if (config.editor) {
  const file = join(config.editor.state_dir, 'tasks.json');
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error('Invalid editor journal');
    const journal = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(journal.tasks) || journal.tasks.some(t => ['applying', 'rolling_back', 'validating', 'recovery_required'].includes(t.state))) throw new Error('Editor has interrupted operations; use local recovery tools before startup');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const editor = await ProjectEditor.create(config.editor, config.reader, { recoverDeadOwner: true });
  await editor.close();
}
console.log(JSON.stringify({ idle_state_ready: true, automatic_edit_replay: false }));
