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
		// cp70 ship state: 481 passed + 1 skipped.  cp78-D20 added 5
		// tip-height depth-check tests.  cp83-D24 LOWERED this baseline
		// to 456 to accommodate an unexplained "stable -30" gap where
		// Forgejo CI reported 456 passing vs 486 locally, and left a
		// cp84+ TODO to chase down which tests were missing in CI.
		//
		// cp170 ROOT-CAUSED and FIXED it: the -30 was release.test.ts
		// (exactly 30 tests) failing to collect in CI.  That file
		// imported apps/web/src/lib/net/releaseValidate.ts for the
		// frontend↔indexer parity invariant; transforming that web
		// file under vitest auto-discovered apps/web/tsconfig.json,
		// which extends ./.svelte-kit/tsconfig.json — a generated file
		// the run-smokes CI job never created, so collection failed
		// with a TSConfckParseError (0 tests instead of 30).
		//
		// The fix was architectural: releaseValidate.ts + its
		// ReleasePayloadV1 schema were extracted into the standalone
		// @morphit/release-schema package (cp170).  release.test.ts
		// now imports the validator from that package — which has its
		// own plain tsconfig, no SvelteKit extends — so it collects in
		// every environment with no sync step.  The cross-app reach is
		// gone entirely.
		//
		// With the gate fixed, the baseline is restored to a tight
		// floor reflecting the true current count (475 passing + 1
		// skipped, identical local and CI).  A drop below this again
		// means a real removal — which is the smoke's load-bearing
		// purpose.
		minPassing: 475,
		notes: 'indexer handler + API tests; tight floor restored at cp170 after extracting the release validator into @morphit/release-schema (fixed the release.test.ts CI collection gap)'
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
	},
	{
		path: 'apps/ops-cli',
		// beta.41 prep: lifted from "no vitest gate" to a real
		// baseline.  ops-cli's only suite is test/time.test.ts — 24
		// pure unit tests of the duration / relative-time helpers
		// (parseDurationSpec, formatDuration, relativeTime,
		// ageSeconds, utcMidnightToday).  No fs/network/env or
		// cross-app imports, so there is zero risk of the indexer-
		// style CI-vs-local collection gap (cp170, release.test.ts):
		// the count is identical in every environment.  This closes
		// the last vitest-bearing workspace that run-smokes did not
		// gate (relay + web + indexer were already covered).
		minPassing: 24,
		notes: 'ops-cli time-helper unit tests; baseline locked at beta.41 prep (pure functions, no cross-app reach)'
	}
];

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── vitest-must-pass smoke (cp71 LL #71 / O-19) ──\n');

function runVitest(workspacePath: string): { passing: number; failing: number; skipped: number; output: string } {
	const fullPath = join(REPO_ROOT, workspacePath);
	if (!existsSync(join(fullPath, 'package.json'))) {
		throw new Error(`workspace missing: ${workspacePath}`);
	}
	let output: string;
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
		// vitest exits non-zero when tests fail.  We still want to parse
		// stdout to learn the counts.
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
	return { passing: passingCount, failing: failingCount, skipped: skippedCount, output };
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
		fail(
			`${ws.path} meets passing-count baseline`,
			`Only ${result.passing} passing; baseline ≥ ${ws.minPassing}.  Tests were silently removed or disabled; check for accidental .skip() / .todo() / file deletions.`
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
