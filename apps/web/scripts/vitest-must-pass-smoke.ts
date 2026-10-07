#!/usr/bin/env tsx
/**
 * vitest-must-pass smoke.
 *
 * The smoke battery is heavy on static-analysis (3900 scenarios)
 * but doesn't run vitest unit tests.  An audit caught 17
 * unit-test failures that had been silently broken across
 * because nobody ran `npm test` between handler edits.  Test-rot
 * means handler-vs-test drift goes undetected: the static smoke
 * passes, the team ships, the regression isn't caught until much
 * later when someone happens to run the unit tests manually.
 *
 * This smoke runs vitest for each workspace that has unit tests
 * and asserts the pass count meets a baseline.  A test-rot incident
 * surfaces immediately as a smoke failure on the next checkpoint.
 *
 * Per-workspace baselines (locked ship):
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
 * Mutation test:  add a deliberately failing assertion to any
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
		// ship state: 481 passed + 1 skipped.  A later change added 5
		// tip-height depth-check tests.  LOWERED this baseline
		// to 456 to accommodate an unexplained "stable -30" gap where
		// Forgejo CI reported 456 passing vs 486 locally, and left a
		// later TODO to chase down which tests were missing in CI.
		//
		// ROOT-CAUSED and FIXED it: the -30 was release.test.ts
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
		// @morphit/release-schema package.  release.test.ts
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
		notes:
			'indexer handler + API tests; tight floor restored at cp170 after extracting the release validator into @morphit/release-schema (fixed the release.test.ts CI collection gap)'
	},
	{
		path: 'apps/relay',
		// ship state: 244 passed.  Lifted from "no vitest yet"
		// to a real baseline later fixed the 'xrp' test
		// expectation in highValueName.test.ts (test was wrong;
		// 'xrp' is length 3 so short_name fires before
		// dictionary_brand check).
		minPassing: 244,
		notes: 'relay create + queue + policy tests; baseline locked at cp73 ship after cp73-D10 fix'
	},
	{
		path: 'apps/web',
		// ship state: 619 passed + 5 skipped.  Lifted from "no
		// vitest yet" to a real baseline later added the
		// missing seo.privacy_index.{title,description} keys to all
		// 10 locales (the /privacy route's SEO i18n coverage test
		// was failing because the keys didn't exist).
		minPassing: 619,
		notes:
			'web store + i18n + indexer-client tests; baseline locked at cp73 ship after cp73-D11 fix'
	},
	{
		path: 'apps/ops-cli',
		// 81 files / 724 tests at the end of the
		// (the floor had stayed at the 24
		// tests of the one suite ops-cli once had). 721 passed in a tree
		// whose node_modules predate the lockfile (deployMcp.test.ts's 3
		// need `npm ci`), so the floor is 721.
		minPassing: 721,
		notes: 'ops-cli unit + behaviour tests (floor raised after the 2026-10 fixes)'
	},
	{
		path: 'apps/mcp-server',
		// Its unit tests (client keys, the listing-fee gate, the instance
		// DNS guard, order search) ran nowhere: no CI job and no floor here.
		// 22 passing after the 2026-10 fixes.
		minPassing: 22,
		notes: 'mcp-server unit tests; gated since the 2026-10 fixes'
	}
];

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── vitest-must-pass smoke (cp71 LL #71 / O-19) ──\n');

function runVitest(workspacePath: string): {
	passing: number;
	failing: number;
	skipped: number;
	output: string;
} {
	const fullPath = join(REPO_ROOT, workspacePath);
	if (!existsSync(join(fullPath, 'package.json'))) {
		throw new Error(`workspace missing: ${workspacePath}`);
	}
	// This smoke runs under tsx, which hands its --tsconfig to child processes
	// as TSX_TSCONFIG_PATH — a path RELATIVE to the smoke's directory. Tests
	// that spawn tsx themselves (the self-heal subcommand, the relay drain
	// guard, CLI tests) then look for that file in their own workspace and
	// exit 1 at once. Each workspace's vitest uses its own config.
	const childEnv: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
	delete childEnv.TSX_TSCONFIG_PATH;
	let output: string;
	try {
		output = execSync('npx vitest run --reporter=basic', {
			cwd: fullPath,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
			// 10 minutes max per workspace. apps/ops-cli's suite (real child
			// processes, PTY spinner checks, fake docker/systemctl) takes ~170 s
			// on an idle 2-CPU host and ~290 s with the CPUs busy (2026-10-06):
			// 5 minutes cut it off mid-run, which read as "could not parse".
			// The whole smoke is still bounded by the runner's slow-smoke cap.
			timeout: 10 * 60_000,
			// CI=1 forces the basic reporter (defensive — `--reporter=basic` on
			// the CLI takes precedence but VITEST_REPORTERS in env could override it).
			env: childEnv
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
	const summaryMatch = stripped.match(
		/Tests\s+(?:(\d+)\s+failed\s*\|)?\s*(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/
	);
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
		// when a workspace reports failures, extract the
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
