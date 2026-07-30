/**
 * setup-bootstrap-smoke.ts (cp600) — guards the grandma bootstrap launcher
 * `morphit-setup.sh`, the ONE command that takes a bare extract to a running
 * install wizard.  It can't be executed in CI (it apt-installs Node), so this
 * pins the shape that keeps it safe + correct: root guard, apt-only guard that
 * DOESN'T guess on other distros, a real Node-version threshold check,
 * NodeSource install only when missing (idempotent), npm install, and a
 * hand-off to `morphit-ops install`.  Anti-pattern greps strip comment lines
 * first (the header legitimately says "never deletes/overwrites").
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(ROOT, 'morphit-setup.sh');
const raw = readFileSync(SETUP, 'utf-8');
// Code with comment lines stripped, for anti-pattern greps.
const code = raw
	.split('\n')
	.filter((l) => !/^\s*#/.test(l))
	.join('\n');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

console.log('\u2500\u2500 setup-bootstrap smoke (cp600) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

// ── Safety guards ─────────────────────────────────────────────────
check('runs from the extracted folder (checks package.json)', /\[ -f package\.json \]/.test(code) && /cd "\$HERE"/.test(code));
check('requires root (id -u guard + exit)', /\[ "\$\(id -u\)" -ne 0 \]/.test(code));
check('apt-only guard points at docs + STOPS on other package managers', /command -v apt-get/.test(code) && /RUN-A-MORPHIT-NODE\.md/.test(code) && /Unsupported package manager/.test(code));
check('does NOT silently guess another package manager (no yum/dnf/pacman/brew install)', !/\b(yum|dnf|pacman|brew|zypper)\s+install/.test(code));
check('non-destructive — no rm -rf / mkfs / dd on the box', !/rm\s+-rf\s+\//.test(code) && !/\bmkfs\b/.test(code) && !/\bdd\s+if=/.test(code));
check('set -euo pipefail (fail fast, catch pipe errors)', /set -euo pipefail/.test(code));

// ── Node install logic ────────────────────────────────────────────
check('a real major-version threshold of 22 (not just "is node present")', /NODE_MAJOR_MIN=22/.test(code) && /process\.versions\.node/.test(code) && /-ge "\$NODE_MAJOR_MIN"/.test(code));
check('installs Node from NodeSource for the SAME major when missing', /deb\.nodesource\.com\/setup_\$\{NODE_MAJOR_MIN\}\.x/.test(code) && /apt-get install -y nodejs/.test(code));
check('idempotent — checks node_ok BEFORE installing (an "already installed" branch)', /if node_ok; then[\s\S]{0,120}already installed/.test(code));
check('re-verifies Node after install (fails loudly if still too old)', /node_ok \|\| die/.test(code));

// ── Deps + hand-off ───────────────────────────────────────────────
check('installs project libraries (npm install)', /\bnpm install\b/.test(code));
check('hands off to the guided installer (morphit-ops install)', /exec npx --no-install morphit-ops install/.test(code));
check('installs git only if absent (guarded)', /command -v git[\s\S]{0,80}apt-get install -y git/.test(code));

// ── Real shell syntax check ───────────────────────────────────────
const bn = spawnSync('bash', ['-n', SETUP], { encoding: 'utf-8' });
check('passes `bash -n` (no shell syntax errors)', bn.status === 0);
if (bn.status !== 0) console.log('    bash -n said:\n' + (bn.stderr || '').split('\n').map((l) => '      ' + l).join('\n'));

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} setup-bootstrap checks passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failed} of ${passed + failed} setup-bootstrap checks failed`);
	process.exit(1);
}
