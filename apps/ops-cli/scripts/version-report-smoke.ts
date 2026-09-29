/**
 * version-report smoke (review B13 / H-13).
 *
 * `morphit-ops --version` printed a hardcoded "0.1.0" that never moved, so it
 * could not be trusted and drifted from every release. It must report the
 * version in apps/ops-cli/package.json (the file the release bumps). Behavioural:
 * SPAWN the real bin and compare its output to package.json.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const WS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = (
	JSON.parse(readFileSync(join(WS, 'package.json'), 'utf8')) as { version: string }
).version;

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}`);
	}
};

const run = spawnSync(process.execPath, [join(WS, 'bin', 'morphit-ops.mjs'), '--version'], {
	encoding: 'utf8',
	timeout: 60_000
});
const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();

check('--version exits 0', run.status === 0);
check(`--version prints the package.json version (${pkgVersion})`, out.includes(pkgVersion));
check(
	'--version does NOT print the old hardcoded 0.1.0',
	!/\b0\.1\.0\b/.test(out) || pkgVersion === '0.1.0'
);

console.log(
	fail === 0 ? `✓ all ${pass} version-report checks hold` : `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
