#!/usr/bin/env tsx
/**
 * backup-script-posix-safety — cp514 (post-v1.8.7, found live on Ken's VPS).
 *
 * THE BUG THIS EXISTS TO CATCH. `ops/backup/morphit-backup.sh` is `#!/bin/sh`,
 * which on every Debian/Ubuntu host is DASH. It carried:
 *
 *     ( set -o pipefail 2>/dev/null || true ) >/dev/null
 *
 * `pipefail` is not POSIX and dash rejects it. `set` is a SPECIAL builtin, so
 * dash exits the shell IMMEDIATELY on a bad option — it never reaches the
 * `|| true`, and the failing subshell's status then trips the parent's
 * `set -e`. The `2>/dev/null` swallowed the one diagnostic. Net effect: the
 * script exited 2, silently, BEFORE pg_dump ever ran — so the built-in
 * Docker-aware backup shipped in v1.8.4 never produced a single dump on any
 * Ubuntu box. Ken hit it as a bare `status=2/INVALIDARGUMENT` with no message.
 *
 * WHY NOTHING CAUGHT IT: the backup work shipped with STATIC smokes only —
 * nothing ever EXECUTED the script, and `sh -n` parses it fine (it's a runtime
 * option error, not a syntax error). So this smoke actually runs the guard
 * under dash.
 *
 * Tamper tests (each must turn this red):
 *   - Restore the `( set -o pipefail 2>/dev/null || true )` form → fails.
 *   - Drop the `if ( ... ); then` condition context → fails.
 *   - Any new bare `set -o pipefail` at top level → fails.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SCRIPT = join(REPO, 'ops/backup/morphit-backup.sh');
const src = readFileSync(SCRIPT, 'utf8');
/** Comment lines are stripped for the anti-pattern checks: the fix's own
 *  explanatory comment necessarily QUOTES the broken form it replaced, and a
 *  naive scan of the whole file would flag that documentation as the bug. */
const code = src
	.split('\n')
	.filter((l) => !/^\s*#/.test(l))
	.join('\n');

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

console.log('\n── backup-script-posix-safety (cp514) ────────────────\n');

check(
	'the broken `|| true` pipefail guard is gone',
	!/\(\s*set -o pipefail\s+2>\/dev\/null\s*\|\|\s*true\s*\)/.test(code),
	'a special-builtin failure in dash exits before `|| true` is ever evaluated'
);
check(
	'pipefail is probed inside an `if` CONDITION (where set -e is suppressed)',
	/if \( set -o pipefail \) 2>\/dev\/null; then/.test(src),
	'only a condition context survives dash exiting the probe subshell'
);
check(
	'no unguarded top-level `set -o pipefail`',
	!/^set -o pipefail/m.test(code),
	'a bare pipefail kills the script outright under dash'
);

// The real proof: run the guard AS WRITTEN under dash with the script's own
// `set -eu`, and confirm execution continues past it.
const guard = /if \( set -o pipefail \) 2>\/dev\/null; then\s*\n\s*set -o pipefail\s*\n\s*fi/.exec(src);
check('the guard block is present verbatim to execute', guard !== null);
if (guard) {
	for (const shell of ['dash', 'sh', 'bash']) {
		let ok = false;
		let out = '';
		try {
			out = execFileSync(shell, ['-c', `set -eu\n${guard[0]}\necho REACHED`], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe']
			});
			ok = out.includes('REACHED');
		} catch (err) {
			ok = false;
			out = String((err as { stderr?: string }).stderr ?? err);
		}
		check(
			`execution continues past the guard under ${shell} (reaches the dump step)`,
			ok,
			`the script would exit before pg_dump — silent, backup-less. got: ${out.trim().slice(0, 120)}`
		);
	}
}

// Whole-file parse under the shebang's own interpreter.
try {
	execFileSync('sh', ['-n', SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'] });
	check('morphit-backup.sh parses clean under /bin/sh', true);
} catch (err) {
	check('morphit-backup.sh parses clean under /bin/sh', false, String(err));
}

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} backup-script-posix-safety checks passed` : '✗ backup-script-posix-safety FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
