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
		// cp70 ship state: 481 passed + 1 skipped.  A future
		// checkpoint should only increase this; losing tests
		// silently shouldn't be a clean smoke.
		minPassing: 481,
		notes: 'indexer handler + API tests; baseline locked at cp70 ship'
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
		fail(
			`${ws.path} has no failing tests`,
			`${result.failing} test(s) failing.  Test-rot or regression; run \`cd ${ws.path} && npx vitest run\` to investigate.`
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
