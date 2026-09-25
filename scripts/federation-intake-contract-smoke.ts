#!/usr/bin/env tsx
/**
 * federation-intake-contract-smoke — the intake stats contract, pinned on BOTH
 * sides.
 *
 * WHY THIS EXISTS. `morphit-ops health` reads the receiving side of federated
 * chat out of `/v1/health` → `fastpath.federationIntake`, which is the indexer's
 * `federationChatFastRoute().stats()` passed through verbatim. Two files, two
 * repos' worth of distance, and nothing tying the key names together.
 *
 * They drifted immediately. The CLI was written to read `intake.accepted`; the
 * indexer has never emitted a key called `accepted` — its counter is `verified`.
 * So `intakeAccepted` was permanently null and the line it guards, "received N
 * from peers", never printed on any instance. The unit test passed throughout,
 * because its fixture was written by hand from the same wrong assumption: it
 * declared `federationIntake: { accepted: 7, shed: 2 }` and proved only that the
 * parser could read the fixture.
 *
 * That trap is not new here. `fastpath-writes-nothing.test.ts` carries the line
 * "A fixture that invents its own shape proves the path accepts THE FIXTURE",
 * written one round earlier, about a different file. A comment in one test does
 * not protect another; a contract check does.
 *
 * WHAT IS PINNED: every key the CLI reads must be a key the indexer emits. Read
 * off the SOURCE of both, so neither can be renamed without this failing — which
 * is the same remedy this release already applied to the browser's inbox-ping
 * contract, for the same reason.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEXER = join(REPO, 'apps/indexer/src/api/federationChatFast.ts');
const CLI = join(REPO, 'apps/ops-cli/src/commands/health.ts');

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

const indexerSrc = readFileSync(INDEXER, 'utf8');
const cliSrc = readFileSync(CLI, 'utf8');

/**
 * The keys the indexer's `stats()` returns, read off its declared shape.
 *
 * Parsed from the `stats(): { … }` interface member rather than from the
 * object literal: the literal uses shorthand (`verified,`) which is easy to
 * match loosely and easy to get wrong, while the interface names every key with
 * its type and is what a reader would call the contract.
 */
function indexerStatsKeys(): Set<string> {
	const m = /stats\(\):\s*\{([\s\S]*?)\n\t\};/.exec(indexerSrc);
	if (m === null) return new Set();
	const keys = new Set<string>();
	for (const line of m[1]!.split('\n')) {
		const k = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
		if (k !== null) keys.add(k[1]!);
	}
	return keys;
}

/** Every `intake.<key>` the CLI reads out of the federationIntake block. */
function cliReadKeys(): Set<string> {
	const keys = new Set<string>();
	const re = /\bintake\.([A-Za-z_][A-Za-z0-9_]*)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cliSrc)) !== null) keys.add(m[1]!);
	return keys;
}

const emitted = indexerStatsKeys();
const read = cliReadKeys();

if (emitted.size >= 4) ok(`indexer stats() declares ${emitted.size} keys`);
else bad('could not parse the indexer stats() shape', [...emitted].join(',') || '(none)');

if (read.size > 0) ok(`ops CLI reads ${read.size} intake key(s)`);
else bad('could not find any intake.<key> reads in the ops CLI — has it been rewritten?');

// THE CHECK. Every key the CLI reads must be one the indexer actually sends.
{
	const ghosts = [...read].filter((k) => !emitted.has(k));
	if (ghosts.length === 0) {
		ok('every intake field the CLI reads is one the indexer emits');
	} else {
		bad(
			'the CLI reads intake field(s) the indexer never sends — they will always be null',
			`${ghosts.join(', ')}  (indexer emits: ${[...emitted].sort().join(', ')})`
		);
	}
}

// The specific one that was broken, named so a regression is unmistakable.
if (emitted.has('verified') && cliSrc.includes('numOrNull(intake.verified)')) {
	ok('the peer-received count is sourced from `verified`, the key that exists');
} else {
	bad(
		'the peer-received count is not reading `verified`',
		'this is the exact defect the smoke was written for: it read `accepted`, which nothing emits'
	);
}

if (!cliSrc.includes('intake.accepted')) {
	ok('the phantom `accepted` key is gone');
} else {
	bad('the CLI still reads intake.accepted — no indexer has ever emitted it');
}

// The admission bound is the operator-facing part of the time-derived queue, so
// both halves have to agree it exists.
for (const k of ['admissionDepth', 'verifyCostMs', 'replayTableFull']) {
	if (emitted.has(k) && read.has(k)) ok(`intake diagnostic carried end to end: ${k}`);
	else bad(`intake diagnostic not wired through: ${k}`, `emitted=${emitted.has(k)} read=${read.has(k)}`);
}

// The CLI's display threshold must match the indexer's ceiling, or the "queue
// held to N" line appears on healthy instances or hides on degraded ones.
{
	const iv = /export const VERIFY_QUEUE_MAX = ([0-9_]+);/.exec(indexerSrc);
	const cv = /const INTAKE_QUEUE_CEILING = ([0-9_]+);/.exec(cliSrc);
	if (iv === null || cv === null) {
		bad('could not read both queue ceilings', `indexer=${iv?.[1] ?? 'not found'} cli=${cv?.[1] ?? 'not found'}`);
	} else if (iv[1]!.replace(/_/g, '') === cv[1]!.replace(/_/g, '')) {
		ok(`queue ceiling agrees on both sides (${iv[1]})`);
	} else {
		bad('queue ceiling disagrees', `indexer=${iv[1]} cli=${cv[1]}`);
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('✗ federation-intake contract FAILED');
	process.exit(1);
}
console.log(`✓ all ${pass} federation-intake contract scenarios passed`);
