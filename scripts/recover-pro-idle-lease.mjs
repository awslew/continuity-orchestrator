// Explicit local recovery only. Unknown writes and worker history fail closed.
import { readFile } from 'node:fs/promises';
import { ProState } from '../dist/src/project-reader/pro-state.js';
import { proConfigSchema } from '../dist/src/project-reader/pro.js';
const [configPath, acknowledgement] = process.argv.slice(2);
if (!configPath || acknowledgement !== 'ACKNOWLEDGE_IDLE_LEASE_RECOVERY') throw new Error('Usage: node scripts/recover-pro-idle-lease.mjs <config> ACKNOWLEDGE_IDLE_LEASE_RECOVERY');
const config = proConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
if (!config.bridge) throw new Error('No Bridge configured');
const entries = JSON.parse(await readFile(config.bridge.workspaces_config, 'utf8'));
const state = await ProState.acquire(config.bridge.workspaces_config + '.pro-state.json', { bridge: config.bridge, entries }, entries.map(e => e.root), { recoverIdleOwner: true });
try { console.log(JSON.stringify({ recovered_idle_lease: true, retained_patches: state.patches.length, unknown_effects: state.inFlight !== null })); }
finally { await state.close(); }
