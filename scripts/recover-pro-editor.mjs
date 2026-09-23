// Local operator entry. Never used by a Chat tool or as an automatic retry.
import { readFile } from 'node:fs/promises';
import { ProjectEditor } from '../dist/src/project-reader/editor.js';
import { proConfigSchema } from '../dist/src/project-reader/pro.js';
const [configPath, action = 'inspect', taskId, acknowledgement] = process.argv.slice(2);
if (!configPath || !['inspect', 'rollback'].includes(action)) throw new Error('Usage: node scripts/recover-pro-editor.mjs <config> inspect|rollback <task-id> [ACKNOWLEDGE_LOCAL_RECOVERY]');
const acknowledged = acknowledgement === 'ACKNOWLEDGE_LOCAL_RECOVERY';
if (action === 'rollback' && !acknowledged) throw new Error('Review inspect output first, then provide ACKNOWLEDGE_LOCAL_RECOVERY to roll back only matching proposal files.');
const config = proConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
if (!config.editor) throw new Error('No editor configured');
const editor = await ProjectEditor.create(config.editor, config.reader, { recoverDeadOwner: acknowledged });
try {
  console.log(JSON.stringify(taskId ? action === 'rollback' ? await editor.recoverApply(taskId) : await editor.inspectRecovery(taskId) : editor.status(), null, 2));
} finally { await editor.close(); }
