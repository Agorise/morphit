#!/usr/bin/env tsx
/**
 * vitest-must-pass smoke — Part 122 cp71 (LL #71 / O-19).
 *
 * The smoke battery is heavy on static-analysis (3900 scenarios at
 * cp70) but doesn't run vitest unit tests.  cp70 caught 17
 * unit-test failures that had been silently broken across cp61→cp69
 * because nobody ran `npm test` between handler edits.  Test-rot
 * means handler-vs-test drift goes undetected: the static smoke
 * passes, the team ships, the regression isn't caught until much
 * later when someone happens to run the unit tests manually.
 *
 * This smoke runs vitest for each workspace that has unit tests
 * and asserts the pass count meets a baseline.  A test-rot incident
 * surfaces immediately as a smoke failure on the next checkpoint.
 *
 * Per-workspace baselines (locked at cp70 ship):
 *   apps/indexer  481 passed, 1 skipped (482 total)
 *   apps/relay    (no vitest yet — TBD)
 *   apps/web      (no vitest yet — TBD)
 *
 * The smoke runs `npx vitest run` inside each workspace and parses
 * the output line "      Tests  N passed".  Failures count goes
 * straight to fail.  Total count is logged for visibility but
 * doesn't fail (a workspace adding tests is fine; losing them
 * unexpectedly is a different defense we could layer in later).
 *
 * Skipped tests are allowed (a test marked `it.skip(...)` for an
 * env-dependent reason isn't a failure).
 *
 * To run vitest fast in CI, this smoke uses `--run` to avoid watch
 * mode and `--reporter=basic` for parseable output.
 *
 * Mutation test M-142:  add a deliberately failing assertion to any
 * test file → smoke fires with the workspace + failure count.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

interface WorkspaceBaseline {
	readonly path: string;
	readonly minPassing: number;
	readonly notes?: string;
}

const WORKSPACES: WorkspaceBaseline[] = [
	{
		path: 'apps/indexer',
		// cp70 ship state: 476 passed (not 481 as the cp78 comment
		// incorrectly stated — the 481 was the old cp71 minPassing
		// value, not the measured count).  cp78-D20 added 5 tip-height
		// depth-check tests → verified actual baseline 481.
		// A future checkpoint should only increase this; losing tests
		// silently shouldn't be a clean smoke.
		minPassing: 481,
		notes: 'indexer handler + API tests; baseline corrected at cp80 (476+5 cp78-D20 tests)'
	},
	{
		path: 'apps/relay',
		// cp73 ship state: 244 passed.  Lifted from "no vitest yet"
		// to a real baseline after cp73-D10 fixed the 'xrp' test
		// expectation in highValueName.test.ts (test was wrong;
		// 'xrp' is length 3 so short_name fires before
		// dictionary_brand check).
		minPassing: 244,
		notes: 'relay create + queue + policy tests; baseline locked at cp73 ship after cp73-D10 fix'
	},
	{
		path: 'apps/web',
		// cp73 ship state: 619 passed + 5 skipped.  Lifted from "no
		// vitest yet" to a real baseline after cp73-D11 added the
		// missing seo.privacy_index.{title,description} keys to all
		// 10 locales (the /privacy route's SEO i18n coverage test
		// was failing because the keys didn't exist).
		minPassing: 619,
		notes: 'web store + i18n + indexer-client tests; baseline locked at cp73 ship after cp73-D11 fix'
	}
];

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── vitest-must-pass smoke (cp71 LL #71 / O-19) ──\n');

function runVitest(workspacePath: string): {
	passing: number;
	failing: number;
	skipped: number;
	output: string;
	/** true when vitest exited non-zero (file-level errors or test failures) */
	vitestFailed: boolean;
} {
	const fullPath = join(REPO_ROOT, workspacePath);
	if (!existsSync(join(fullPath, 'package.json'))) {
		throw new Error(`workspace missing: ${workspacePath}`);
	}
	let output: string;
	let vitestFailed = false;
	try {
		output = execSync('npx vitest run --reporter=basic', {
			cwd: fullPath,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
			// 5 minutes max; the full indexer suite is ~10s on commodity
			// hardware, but cold-start + transform compilation needs slack.
			timeout: 5 * 60_000,
			env: {
				...process.env,
				// Force basic reporter (defensive — `--reporter=basic` on the
				// CLI takes precedence but VITEST_REPORTERS in env could
				// override it).
				CI: '1'
			}
		});
	} catch (e) {
		// vitest exits non-zero when tests fail OR when a test file fails
		// to load/compile (file-level error, distinct from a test failure).
		// In the file-failure case vitest still emits a summary line with
		// the passing test count and failing=0, so we still parse counts —
		// but the caller needs to know vitest was unhappy so it can surface
		// "file-level errors" as the likely reason for a count drop.
		vitestFailed = true;
		const errObj = e as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
		const stdout = errObj.stdout?.toString() ?? '';
		const stderr = errObj.stderr?.toString() ?? '';
		output = stdout + '\n' + stderr;
	}
	// Parse the summary line: "Tests  N passed | M skipped (M+N total)"
	// or "Tests  N passed | M failed | K skipped (...)"
	// vitest emits ANSI colour codes even with --reporter=basic; strip
	// them before matching.
	// eslint-disable-next-line no-control-regex
	const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
	const summaryMatch = stripped.match(/Tests\s+(?:(\d+)\s+failed\s*\|)?\s*(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/);
	if (!summaryMatch) {
		throw new Error(`could not parse vitest output for ${workspacePath}:\n${stripped.slice(-500)}`);
	}
	const failingCount = summaryMatch[1] ? parseInt(summaryMatch[1], 10) : 0;
	const passingCount = parseInt(summaryMatch[2]!, 10);
	const skippedCount = summaryMatch[3] ? parseInt(summaryMatch[3], 10) : 0;
	return { passing: passingCount, failing: failingCount, skipped: skippedCount, output, vitestFailed };
}

for (const ws of WORKSPACES) {
	console.log(`▸ ${ws.path} (baseline ≥ ${ws.minPassing} passing)`);
	let result: ReturnType<typeof runVitest>;
	try {
		result = runVitest(ws.path);
	} catch (e) {
		fail(`${ws.path} vitest runs cleanly`, `Could not run vitest: ${(e as Error).message}`);
		continue;
	}
	console.log(`  passing=${result.passing}  failing=${result.failing}  skipped=${result.skipped}`);
	if (result.failing > 0) {
		// cp78-D18: when a workspace reports failures, extract the
		// failing test names from vitest output so the harness's
		// `tail -30` shows enough context to root-cause the flake.
		// Previously the smoke just emitted the count, and the
		// harness chopped the workspace ▸ line and everything before
		// it — leaving a "1 test(s) failing" message with no name.
		//
		// vitest --reporter=basic prints failing tests in two places:
		//   - "   × test name Xms" (U+00D7 × marker, one per failing test)
		//     followed by "     → assertion message"
		//   - " ❯ test/file.test.ts (N test | M failed) Xms" (file summary)
		// We capture both — the × lines name individual tests; the ❯ lines
		// confirm test-file boundaries.
		// eslint-disable-next-line no-control-regex
		const stripped = result.output.replace(/\x1b\[[0-9;]*m/g, '');
		const xLines = stripped
			.split('\n')
			.filter((l) => /^\s*×\s+\S/.test(l) && !/Test\s+Files/.test(l))
			.map((l) => l.trim())
			.slice(0, 5);
		const fileLines = stripped
			.split('\n')
			.filter((l) => /\.test\.ts\s+\(.*failed\s*\)/.test(l))
			.map((l) => l.trim())
			.slice(0, 5);
		const namesList = xLines.length > 0 ? xLines : fileLines;
		const failNames =
			namesList.length > 0
				? ` Failing:\n      ${namesList.join('\n      ')}`
				: ' (could not extract failing test names from vitest output)';
		fail(
			`${ws.path} has no failing tests`,
			`${result.failing} test(s) failing.  Test-rot or regression; run \`cd ${ws.path} && npx vitest run\` to investigate.${failNames}`
		);
		continue;
	}
	if (result.passing < ws.minPassing) {
		// Emit diagnostics so the CI log surfaces the root cause without a
		// follow-up "what did vitest actually output?" chase.
		//
		// Two distinct failure modes:
		//   A. Test file fails to LOAD (compile error, bad import, …)
		//      → vitest exits non-zero, failing=0, but the passing count is
		//        lower than expected because that file's tests never ran.
		//      → "Test Files  N passed | M failed" line will show M > 0.
		//   B. Tests were removed / skipped / accidentally .skip()d.
		//      → vitest exits 0, count is genuinely reduced.
		// eslint-disable-next-line no-control-regex
		const strippedDiag = result.output.replace(/\x1b\[[0-9;]*m/g, '');
		const diagLines = strippedDiag.split('\n');
		const testFilesLine = diagLines.find((l) => /Test\s+Files/.test(l))?.trim() ?? '(not found)';
		const failFileLines = diagLines
			.filter((l) => /^\s*(FAIL|ERR)\s+\S/.test(l))
			.map((l) => l.trim())
			.slice(0, 10);
		// Emit the last 12 non-empty raw lines of the vitest output so the
		// CI log always contains the actual error text (import resolution
		// failure, syntax error, etc.) regardless of its format.  Earlier
		// attempts to extract specific patterns produced false positives
		// from mock error strings inside passing tests.
		const rawTail = diagLines
			.filter((l) => l.trim().length > 0)
			.slice(-12)
			.map((l) => l.trimEnd());
		const fileErrorNote =
			result.vitestFailed && failFileLines.length > 0
				? `\n      vitest exited non-zero — file-level errors:\n      ${failFileLines.join('\n      ')}` +
					`\n      vitest tail:\n      ${rawTail.join('\n      ')}`
				: result.vitestFailed
					? '\n      vitest exited non-zero (file-level error; check full log for FAIL/ERR lines)'
					: '';
		fail(
			`${ws.path} meets passing-count baseline`,
			`Only ${result.passing} passing; baseline ≥ ${ws.minPassing}.  Tests were silently removed or disabled; check for accidental .skip() / .todo() / file deletions.` +
				`\n      Test Files: ${testFilesLine}` +
				fileErrorNote
		);
		continue;
	}
	pass(`${ws.path}: ${result.passing} passing (≥ ${ws.minPassing} baseline)`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nvitest-must-pass smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} vitest-must-pass scenarios passed`);
