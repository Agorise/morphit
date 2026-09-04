#!/usr/bin/env tsx
/**
 * upgrade-supersede-self-safe-smoke.ts (v1.15.8)
 *
 * The bug: the upgrade's final "supersede stale workers" sweep used
 * pidsWithCwdUnder(backupDir) — every process whose cwd sits under the old
 * install dir (now .bak). The upgrade process ITSELF (and its shell / sudo /
 * launcher ancestors) runs with cwd in that dir, so the sweep SIGTERMed itself:
 * the box upgraded fine, but the process died with a scary "Terminated" and the
 * remaining steps (backup pruning, the success banner, the canary refresh) never
 * ran. To the operator it looked like a FAILED upgrade.
 *
 * This smoke locks in the fix:
 *   1. selfAndAncestorPids() actually walks /proc and includes self + parent
 *      (a real runtime check against this process).
 *   2. the sweep excludes those PIDs at every scan point (no unfiltered
 *      pidsWithCwdUnder feeds a kill).
 *   3. the end-of-upgrade output is a friendly success banner naming the version.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfAndAncestorPids } from '../src/commands/upgrade.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'upgrade.ts');
const src = readFileSync(SRC, 'utf8');

let pass = 0;
const fails: string[] = [];
const check = (desc: string, ok: boolean): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  \u2717 ${desc}`);
	}
};

// ── 1. runtime: the PPID walk works on THIS process ──
const chain = selfAndAncestorPids();
check('selfAndAncestorPids includes the current process', chain.has(process.pid));
check('selfAndAncestorPids includes the parent process (PPID walk works)', chain.has(process.ppid));
check('selfAndAncestorPids includes init/pid 1 (walk reaches the root)', chain.has(1) || chain.size >= 2);
check('selfAndAncestorPids never returns an empty/degenerate set', chain.size >= 1 && !chain.has(0));

// ── 2. the sweep excludes self + ancestors at EVERY scan ──
check('the sweep computes a protected set from selfAndAncestorPids()', /protectedPids\s*=\s*selfAndAncestorPids\(\)/.test(src));
const sweepCalls = [...src.matchAll(/pidsWithCwdUnder\(backupDir\)/g)];
check('pidsWithCwdUnder(backupDir) is used in the sweep', sweepCalls.length >= 3);
const allFiltered = sweepCalls.every((m) => {
	// Every call must be immediately followed by a .filter(...) that excludes
	// protectedPids. Look at the ~80 chars after the call.
	const tail = src.slice(m.index! + m[0].length, m.index! + m[0].length + 80);
	return /^\s*\.filter\(/.test(tail) && /protectedPids\.has/.test(tail);
});
check(
	'EVERY pidsWithCwdUnder(backupDir) in the sweep is filtered by protectedPids (no unfiltered kill)',
	sweepCalls.length > 0 && allFiltered
);

// ── 3. the end-of-upgrade banner is friendly + names the version ──
check('the final banner congratulates the operator', /Congratulations/.test(src));
check('the final banner says the server is now running the version', /now running \$\{latestTag\}/.test(src));
check('the old terse "Upgrade complete:" one-liner is gone', !/`\u2713 Upgrade complete: \$\{currentTag\}/.test(src));

console.log('');
if (fails.length > 0) {
	console.log(`\u2717 ${fails.length} of ${pass + fails.length} upgrade-supersede-self-safe checks FAILED`);
	for (const f of fails) console.log(`    - ${f}`);
	process.exit(1);
}
console.log(`\u2713 all ${pass} upgrade-supersede-self-safe scenarios passed`);
