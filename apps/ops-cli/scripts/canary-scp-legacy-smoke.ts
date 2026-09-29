/**
 * canary-scp-legacy smoke (review B4 / D12).
 *
 * Hardened Morphit boxes DISABLE the SSH SFTP subsystem, and modern `scp`
 * defaults to SFTP — so a plain `scp` to morphit.io/morphitir/morphitlat fails
 * with "Connection closed" right after auth. Every scp the canary refresh emits
 * must force the legacy exec-channel transfer with `-O`. This parses the emitted
 * upload commands in scripts/canary/setup.sh (the property is textual: the
 * generated command line must carry the flag).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = readFileSync(join(REPO, 'scripts', 'canary', 'setup.sh'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}`);
	}
};

// Every emitted `scp ...` command (inside a printf that builds the refresh
// script, or run directly) must use -O. Ignore the `command -v scp` probe.
const scpCmds = src
	.split('\n')
	.filter((l) => /\bscp\b/.test(l))
	.filter((l) => !/command -v scp/.test(l))
	.filter(
		(l) =>
			/scp[^\n]*:[^\n]*(canary\.txt|pgp_keys\.asc|apps\/web\/build)/.test(l) || /\bscp -/.test(l)
	);

check('found the canary scp upload command(s)', scpCmds.length >= 1);
for (const cmd of scpCmds) {
	check(
		`scp forces legacy transfer (-O): ${cmd.trim().slice(0, 60)}…`,
		/\bscp\s+(?:-\w+\s+)*-O\b|\bscp\s+-O\b/.test(cmd)
	);
}

console.log(
	fail === 0 ? `✓ all ${pass} canary-scp-legacy checks hold` : `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
