/**
 * wizard-step-count-doc-parity smoke (cp171).
 *
 * Makes the operator-wizard step count self-synchronizing across
 * code and docs.  `apps/ops-cli/src/init/steps.ts` declares the
 * canonical `const TOTAL_STEPS = N`; every operator-facing doc
 * that quotes a prompt/step count must match it.
 *
 * WHY THIS EXISTS — recurring drift:
 *   The wizard step count has drifted from its doc references at
 *   least three times as operator-config surface was added:
 *     - cp22 inserted a step (15 → 16); doc "~17 prompts" went
 *       stale (AUDIT-2026-05 D-9 / DD-cp27-DD-13/20 fixed it).
 *     - cp167 added the MCP step (18 → 20).  That bump updated
 *       the F14b TOTAL_STEPS sentinel in persona-walkthrough-
 *       smoke but MISSED the prose count in README, PRE-LAUNCH-
 *       CHECKLIST, METADATA-LEAK-CATALOG, and the init.ts JSDoc
 *       ("19 ELI5"), which all stayed at the pre-cp167 numbers.
 *       cp171 fixed those and added this smoke so the next bump
 *       can't repeat the miss.
 *
 * The F14b sentinel only pins the literal `const TOTAL_STEPS =
 * 20` line — it catches an UNDECLARED change to the constant but
 * not the doc drift that follows a DECLARED change.  This smoke
 * closes that gap: it derives N from steps.ts at runtime and
 * fails the instant any tracked doc quotes a different number.
 *
 * The companion persona-walkthrough So-4 / D-9 scenarios pin the
 * exact doc strings; this smoke pins the code↔doc relationship.
 * If you bump TOTAL_STEPS, update every file listed in
 * DOC_CLAIMS below (and the two persona-smoke pins) in the same
 * work unit and this smoke goes green again.
 *
 * Out of scope: historical audit/archive logs (AUDIT-2026-05.md,
 * REVISIT-LIST*.md, *WALKTHROUGH-cp*.md, RELEASE-NOTES*.md) that
 * record a count as it was at a past checkpoint.  Those are
 * deliberately frozen and not scanned here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

function read(rel: string): string {
	return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/* ---------------- derive the canonical count ---------------- */

const STEPS_SRC = read('apps/ops-cli/src/init/steps.ts');

const totalMatch = STEPS_SRC.match(/const\s+TOTAL_STEPS\s*=\s*(\d+)\s*;/);
let TOTAL_STEPS = -1;
if (!totalMatch) {
	fail(
		'steps.ts declares `const TOTAL_STEPS = N`',
		'could not find the canonical TOTAL_STEPS constant — has it been renamed?'
	);
} else {
	TOTAL_STEPS = Number(totalMatch[1]);
	pass(`steps.ts canonical TOTAL_STEPS = ${TOTAL_STEPS}`);
}

/* Cross-check: the number of `step(N, TOTAL_STEPS, …)` calls must
 * equal TOTAL_STEPS, and the highest N must equal TOTAL_STEPS.
 * Guards against the constant and the actual step() calls drifting
 * apart (e.g. a step removed but the constant left high). */
if (TOTAL_STEPS > 0) {
	const stepCalls = [...STEPS_SRC.matchAll(/\bstep\(\s*(\d+)\s*,\s*TOTAL_STEPS\b/g)].map((m) =>
		Number(m[1])
	);
	const count = stepCalls.length;
	const maxN = stepCalls.length > 0 ? Math.max(...stepCalls) : 0;
	if (count !== TOTAL_STEPS) {
		fail(
			'step() call count matches TOTAL_STEPS',
			`found ${count} step(N, TOTAL_STEPS, …) calls but TOTAL_STEPS = ${TOTAL_STEPS}`
		);
	} else {
		pass(`step() call count matches TOTAL_STEPS (${count})`);
	}
	if (maxN !== TOTAL_STEPS) {
		fail(
			'highest step number equals TOTAL_STEPS',
			`highest step(N, …) is ${maxN} but TOTAL_STEPS = ${TOTAL_STEPS}`
		);
	} else {
		pass(`highest step number equals TOTAL_STEPS (${maxN})`);
	}
}

/* ---------------- doc claims that must match ---------------- */

interface DocClaim {
	/** repo-relative path of the operator-facing doc/source */
	path: string;
	/** human label for the claim's location */
	where: string;
	/** builds the exact substring the doc must contain, given N */
	expect: (n: number) => string;
	/** builds a regex that matches the SAME claim with ANY number,
	 *  so a stale-but-present claim is detected (vs simply missing) */
	anyNumber: RegExp;
}

const DOC_CLAIMS: DocClaim[] = [
	{
		path: 'README.md',
		where: 'README quick-start step 4',
		expect: (n) => `~${n} prompts`,
		anyNumber: /~\d+ prompts/
	},
	{
		path: 'docs/PRE-LAUNCH-CHECKLIST.md',
		where: 'PRE-LAUNCH-CHECKLIST wizard item',
		expect: (n) => `~${n} prompts`,
		anyNumber: /~\d+ prompts/
	},
	{
		path: 'docs/METADATA-LEAK-CATALOG.md',
		where: 'METADATA-LEAK-CATALOG operator-instance section',
		expect: (n) => `roughly ${n} prompts`,
		anyNumber: /roughly \d+ prompts/
	},
	// NOTE: docs/RUN-A-MORPHIT-NODE.md is deliberately NOT pinned to TOTAL_STEPS.
	// It documents the ANSIBLE install wizard (`morphit-setup.sh` → `morphit-ops
	// install` → runAnsibleInstall), NOT the `morphit-ops init` wizard that
	// steps.ts/TOTAL_STEPS counts. The install wizard's step count is VARIABLE
	// (home 15 / vps 11 clearnet, home 11 / vps 9 Tor-only) and self-guarded by
	// runAnsibleInstall's runtime `currentStepNum() === totalSteps` assert, so a
	// single canonical number can't and shouldn't be quoted there. A dedicated
	// regression check below keeps that doc from re-hardcoding a stale count.
	{
		path: 'apps/ops-cli/src/commands/init.ts',
		where: 'init.ts orchestrator JSDoc',
		expect: (n) => `${n} ELI5`,
		anyNumber: /\d+ ELI5/
	}
];

if (TOTAL_STEPS > 0) {
	for (const claim of DOC_CLAIMS) {
		let body: string;
		try {
			body = read(claim.path);
		} catch {
			fail(`${claim.where} (${claim.path}) is readable`, 'file not found');
			continue;
		}
		const want = claim.expect(TOTAL_STEPS);
		if (body.includes(want)) {
			pass(`${claim.where} quotes the canonical count ("${want}")`);
		} else {
			const present = body.match(claim.anyNumber);
			if (present) {
				fail(
					`${claim.where} matches TOTAL_STEPS`,
					`expected "${want}" but found "${present[0]}" — TOTAL_STEPS is ${TOTAL_STEPS}; this doc is stale. Update ${claim.path}.`
				);
			} else {
				fail(
					`${claim.where} matches TOTAL_STEPS`,
					`expected "${want}" but no "${claim.anyNumber}" claim was found at all — did the wording change? Re-anchor this smoke or restore the claim in ${claim.path}.`
				);
			}
		}
	}
}

/* ---------------- install-wizard doc must NOT hardcode a count ----------------
 * The ansible install wizard (RUN-A-MORPHIT-NODE.md) has a VARIABLE step count
 * — it depends on home/vps and clearnet/Tor-only — so any fixed "walks you
 * through N steps" claim there is necessarily wrong for some node. Guard against
 * a well-meaning edit re-introducing one (this is the bug that quoted init's 23
 * on the install-wizard doc). */
{
	let runNode: string;
	try {
		runNode = read('docs/RUN-A-MORPHIT-NODE.md');
		const stale = runNode.match(/walks you through \d+ steps/);
		if (stale) {
			fail(
				'RUN-A-MORPHIT-NODE does not hardcode a wizard step count',
				`found "${stale[0]}" — the install wizard's count is variable (home/vps × clearnet/Tor-only, 9–15); describe it qualitatively instead of pinning a number.`
			);
		} else {
			pass('RUN-A-MORPHIT-NODE does not hardcode a wizard step count (install wizard count is variable)');
		}
	} catch {
		fail('RUN-A-MORPHIT-NODE.md is readable', 'file not found');
	}
}

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log('  ' + ANSI_GREEN + '✓' + ANSI_RESET + ' ' + r.name);
	} else {
		console.log('  ' + ANSI_RED + '✗' + ANSI_RESET + ' ' + r.name);
		if (r.detail) console.log('      ' + r.detail);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log('✗ ' + failed + ' of ' + results.length + ' scenarios failed');
	process.exit(1);
} else {
	console.log('✓ all ' + results.length + ' scenarios passed');
}
