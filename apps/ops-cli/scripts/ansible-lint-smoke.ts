#!/usr/bin/env tsx
/**
 * ansible-lint-smoke — runs `ansible-lint --offline` against
 * ops/ansible/playbook.yml.
 *
 * Soft-skips with a single pass-equivalent if ansible-lint is
 * not installed on the runner (since this is an optional dev
 * tool, not a runtime dep).  Hard-fails if it IS installed
 * and reports any violation — that's a real regression in the
 * playbook quality.
 *
 * To install on a control node or CI runner:
 *   pip install ansible-lint
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const ANSIBLE_ROOT = join(REPO_ROOT, 'ops', 'ansible');
const PLAYBOOK = join(ANSIBLE_ROOT, 'playbook.yml');

function which(cmd: string): string | null {
	const r = spawnSync('which', [cmd], { encoding: 'utf-8' });
	if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
	return null;
}

const lint = which('ansible-lint');

if (!lint) {
	console.log('ansible-lint smoke: SKIP (ansible-lint not installed)');
	console.log(
		'  install with `pip install ansible-lint` on the CI runner / control node'
	);
	console.log('  to actually lint the playbook here.');
	console.log('');
	console.log('✓ all 1 ansible-lint scenarios hold (skipped due to env)');
	process.exit(0);
}

if (!existsSync(PLAYBOOK)) {
	console.error(`FAIL: playbook not found at ${PLAYBOOK}`);
	process.exit(1);
}

console.log(`ansible-lint smoke: running ${lint} --offline\n`);

const lintRun = spawnSync(
	lint,
	['--offline', '--strict', 'playbook.yml'],
	{ cwd: ANSIBLE_ROOT, encoding: 'utf-8' }
);

const stdout = lintRun.stdout ?? '';
const stderr = lintRun.stderr ?? '';

if (lintRun.status === 0) {
	console.log('  ✓ ansible-lint passes against playbook.yml');
	// Show the summary line for the operator's benefit.
	const summary = (stdout + stderr)
		.split('\n')
		.find((l) => /^Passed:/.test(l));
	if (summary) console.log(`      ${summary}`);
	console.log('');
	console.log('✓ all 1 ansible-lint scenarios hold');
	process.exit(0);
}

console.error('  ✗ ansible-lint reported violations:');
// Print the lint output, indented for the runner's display.
for (const line of (stdout + stderr).split('\n')) {
	if (line.trim()) console.error(`      ${line}`);
}
console.error('');
console.error('✗ ansible-lint smoke failed');
process.exit(1);
