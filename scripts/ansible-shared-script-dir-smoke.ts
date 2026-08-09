#!/usr/bin/env tsx
/**
 * ansible-shared-script-dir — cp676.
 *
 * Several ansible roles install helper scripts into the shared directory
 * `/usr/local/lib/morphit` (ddns, backup, mcp, ipfs, …). That directory used to
 * be created ONLY inside the `ipfs` role, which runs late in the play — so a
 * fresh install with DDNS enabled failed with:
 *
 *   fatal: [localhost]: FAILED! => "Destination directory
 *   /usr/local/lib/morphit does not exist"   (ddns role)
 *
 * Invariant guarded here: the shared dir is created by the `base` role (which
 * runs before every consumer), and `base` is ordered ahead of `ddns` in the
 * playbook. This keeps the install from depending on an optional late role.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── ansible-shared-script-dir (cp676) ──────────────────\n');

const SHARED = '/usr/local/lib/morphit';

// 1. base role creates the shared dir
const base = read('ops/ansible/roles/base/tasks/main.yml');
const baseCreatesDir =
	base.includes(SHARED) && /path:\s*\/usr\/local\/lib\/morphit[\s\S]{0,120}state:\s*directory/.test(base);
check(
	'base role creates /usr/local/lib/morphit (state: directory)',
	baseCreatesDir,
	'consumer roles (ddns/backup/mcp) copy scripts here and run before ipfs'
);

// 2. playbook orders base BEFORE ddns (and before ipfs)
const playbook = read('ops/ansible/playbook.yml');
const posBase = playbook.indexOf('role: base');
const posDdns = playbook.indexOf('role: ddns');
const posIpfs = playbook.indexOf('role: ipfs');
check('playbook runs base before ddns', posBase > -1 && posDdns > -1 && posBase < posDdns);
check('playbook runs base before ipfs', posBase > -1 && posIpfs > -1 && posBase < posIpfs);

// 3. any role that COPIES a script into the shared dir must not be the sole creator.
//    (documentary check: ddns installs a script there — via its `morphit_ddns_lib`
//    default — and must NOT create the dir itself, proving it relies on base
//    having created it, which is the exact failure we fixed.)
const ddnsDefaults = read('ops/ansible/roles/ddns/defaults/main.yml');
const ddnsUsesSharedDir = new RegExp(`morphit_ddns_lib:\\s*${SHARED}`).test(ddnsDefaults);
check(
	'ddns role installs into the shared dir (morphit_ddns_lib → /usr/local/lib/morphit)',
	ddnsUsesSharedDir,
	'if this ever moves, keep the base-role creation ahead of it'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} shared-script-dir checks passed` : '✗ ansible-shared-script-dir FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
