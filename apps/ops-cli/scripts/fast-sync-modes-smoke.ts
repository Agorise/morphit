/**
 * fast-sync-modes-smoke — pins two fast-sync robustness fixes (v1.16.14):
 *   1. Both bootstrap spawns SOURCE the indexer's env files (morphit.config.env +
 *      /etc/morphit/indexer.env) so CHAIN_ID/PUBLIC_ORIGIN/OFFICIAL_POSTING_PUBKEY
 *      are present — a stock box couldn't fast-sync without this (morphit.io).
 *   2. A `--from-file` peer-import mode exists (fastSyncFromFile) using the
 *      bootstrap's positional file + `--i-trust-this-source` — for when @morphit
 *      has no fresh on-chain snapshot (publisher rebuilt).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'fastSync.ts'),
	'utf8'
);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) pass++;
	else {
		fail++;
		console.error(`  ✗ ${name}`);
	}
}

check('sources /etc/morphit/indexer.env before the bootstrap (CHAIN_ID etc. present)', /\/etc\/morphit\/indexer\.env/.test(src) && /set -a; for f in/.test(src));
check('sources morphit.config.env too (operator settings)', /morphit\.config\.env/.test(src));
check('has a --from-file peer-import mode', /from-file/.test(src) && /fastSyncFromFile/.test(src));
check('file import uses the bootstrap positional file + --i-trust-this-source', /--i-trust-this-source/.test(src));
check('runFastSync branches to file import when --from-file is set', /fromFile !== null[\s\S]{0,80}fastSyncFromFile/.test(src));
check('both spawns exec via bash -c so the sourced env reaches the bootstrap', (src.match(/spawnSync\('bash', \['-c'/g) || []).length >= 2);
check('checks the ACTUAL indexer service state (systemctl is-active), not just cursor-recency', /systemctl.*is-active.*morphit-indexer/.test(src) && /indexerServiceActive/.test(src));
check('OFFERS to stop a running indexer (askYesNo), does not just refuse', /askYesNo\([^)]*stop it now/.test(src));
check('waits for the indexer to ACTUALLY stop before restoring', /stopIndexerAndWait/.test(src) && /for \(let i = 0; i < 20/.test(src));
check('OFFERS to discard existing data instead of demanding --force', /askYesNo\([\s\S]{0,220}DISCARD it and restore/.test(src));
check('auto-restarts the indexer after a successful restore (wasRunning)', /wasRunning[\s\S]{0,160}systemctl'?, \['start', 'morphit-indexer'\]/.test(src) || /wasRunning[\s\S]{0,200}Restarting the indexer/.test(src));

if (fail === 0) {
	console.log(`✓ all ${pass} fast-sync-modes checks passed`);
} else {
	console.error(`✗ ${fail} of ${pass + fail} fast-sync-modes checks FAILED`);
	process.exit(1);
}
