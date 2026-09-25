#!/usr/bin/env tsx
/**
 * scripts/smoke-runner-env-parity-smoke.ts
 *
 * The two smoke runners must put smokes in the SAME environment.
 *
 * WHY THIS EXISTS
 * `run-smokes.sh` exports `MORPHIT_EMIT_DEDUP=0` for the whole suite, with a
 * long comment explaining that without it a smoke which drives a monitor and
 * asserts on the event it emits will read the 6-hour repeat-suppression as "the
 * error branch never fired". `run-smokes-chunk.sh` — the runner used to split a
 * long battery into pieces, and therefore the one a release validation actually
 * goes through — did not export it.
 *
 * So `sidecar-envelope-error-path-smoke` failed in chunks and passed in the
 * full run, with an error message pointing at the fixture ("fixture may not be
 * triggering the error branch"). Nothing was wrong with the fixture, the
 * monitor, or the code. A runner difference wearing a code defect's clothes
 * costs more than a plain failure, because it sends you to the wrong file with
 * a plausible-looking reason to stay there.
 *
 * This pins the class, not the instance: every environment variable either
 * runner exports must be exported by both, with the same value. Adding a new
 * one to a single runner fails here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  ✓ ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  ✗ ${m}`);
	if (d) console.log(`      ${d}`);
};

/** `export NAME=value` lines, ignoring anything inside a comment. */
function exportedEnv(path: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const raw of readFileSync(path, 'utf8').split('\n')) {
		const line = raw.trim();
		if (line.startsWith('#')) continue;
		const m = /^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
		if (m) out.set(m[1]!, m[2]!.trim());
	}
	return out;
}

console.log('smoke-runner-env-parity — both runners, one environment');
console.log('');

const full = exportedEnv(join(REPO, 'scripts', 'run-smokes.sh'));
const chunk = exportedEnv(join(REPO, 'scripts', 'run-smokes-chunk.sh'));

// A parity check over two empty sets passes while checking nothing.
if (full.size > 0) ok(`run-smokes.sh exports ${full.size} environment variable(s)`);
else bad('run-smokes.sh exports nothing — this parity check would be vacuous');

for (const [name, value] of full) {
	if (!chunk.has(name))
		bad(
			`${name} is exported by run-smokes.sh but NOT by run-smokes-chunk.sh — ` +
				'a smoke will behave differently depending on which runner invoked it'
		);
	else if (chunk.get(name) !== value)
		bad(`${name} differs: run-smokes.sh=${value}, run-smokes-chunk.sh=${chunk.get(name)}`);
	else ok(`${name}=${value} is set identically in both runners`);
}

for (const [name, value] of chunk) {
	if (!full.has(name))
		bad(
			`${name} is exported by run-smokes-chunk.sh but NOT by run-smokes.sh — ` +
				'the full battery would run without it'
		);
	else if (full.get(name) !== value) {
		/* already reported above */
	}
}

// The one that caused this, named explicitly so deleting it from either runner
// is unmistakable rather than just a count going down.
if (full.get('MORPHIT_EMIT_DEDUP') === '0' && chunk.get('MORPHIT_EMIT_DEDUP') === '0')
	ok('MORPHIT_EMIT_DEDUP=0 in both — alert suppression cannot fake a missing event');
else
	bad(
		'MORPHIT_EMIT_DEDUP=0 is not set in both runners; a monitor smoke will report ' +
			'a suppressed repeat as an error branch that never fired'
	);

// The per-smoke wall-clock guard must exist in both too: a runner without it
// turns one hung smoke into a stalled battery (cp142/cp143).
for (const [label, path] of [
	['run-smokes.sh', join(REPO, 'scripts', 'run-smokes.sh')],
	['run-smokes-chunk.sh', join(REPO, 'scripts', 'run-smokes-chunk.sh')]
] as const) {
	const src = readFileSync(path, 'utf8');
	if (/MORPHIT_SMOKE_TIMEOUT/.test(src) && /\btimeout\b/.test(src))
		ok(`${label} applies a per-smoke wall-clock timeout`);
	else bad(`${label} has no per-smoke timeout — one hung smoke would stall the whole battery`);
}

console.log('');
console.log('─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} smoke-runner-env-parity scenarios passed`);
} else {
	console.log(`✗ ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
