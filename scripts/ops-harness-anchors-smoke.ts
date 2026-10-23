/**
 * Smoke: every mutation in the ops/test harnesses still LANDS on the code.
 *
 * WHY THIS EXISTS
 * ---------------
 * A mutation harness (ops/test/*-harness.sh) proves a test is a test: it plants
 * a known bug by replacing an exact piece of source, and the test must fail.
 * When the code is rewritten, the piece is no longer there, the harness says
 * "mutation did not apply" — and the bug it stood for is guarded by nothing.
 * The harnesses take up to an hour each, so they are run by hand, rarely, and
 * the battery never saw this. The v1.21.14 final review found 37 mutations in
 * six harnesses that no longer landed — most since the v1.21.14 chat audit
 * reshaped the code they named — and nine more that landed but were no longer
 * caught.
 *
 * WHAT IT DOES
 * ------------
 * Runs every harness that plants mutations with its test runs replaced by
 * no-ops: the real copy of the tree, the real `mutate` (exact text, exactly
 * once), the real restore — only the slow part is skipped. Seconds, not hours.
 * A harness passes when it ran to its end and no mutation failed to apply.
 * Whether each planted bug is CAUGHT is still the harness's own job.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const HARNESS_DIR = join(REPO, 'ops', 'test');

let checks = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
	checks++;
	if (ok) console.log(`  ✓ ${label}`);
	else {
		failed++;
		console.log(`  ✗ ${label}`);
		if (detail) for (const line of detail.split('\n')) console.log(`      ${line}`);
	}
}

/**
 * The harness's own text with every test run replaced by a no-op, inserted
 * right after its last top-level function — so the stubs win over the real
 * definitions and are in place before the baseline runs.
 */
export function withStubbedRuns(text: string): string {
	const lines = text.split('\n');
	let last = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (!/^[a-z_]+\(\)\s*\{/.test(line)) continue;
		const opens = (line.match(/\{/g) ?? []).length;
		const closes = (line.match(/\}/g) ?? []).length;
		if (opens === closes) {
			last = i;
			continue;
		}
		let j = i + 1;
		while (j < lines.length && lines[j] !== '}') j++;
		last = j;
		i = j;
	}
	if (last < 0) throw new Error('no function definitions found');
	lines.splice(
		last + 1,
		0,
		'# ops-harness-anchors-smoke: test runs stubbed out',
		'run_smoke(){ :; }',
		'run_tests(){ :; }',
		'run_guard(){ :; }',
		'verdict(){ echo pass; }'
	);
	return lines.join('\n');
}

/** The harnesses that plant mutations: they all define `mutate`. */
export function mutationHarnesses(dir: string = HARNESS_DIR): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith('-harness.sh'))
		.filter((f) => /^mutate\(\)\s*\{/m.test(readFileSync(join(dir, f), 'utf8')))
		.sort();
}

/** Run one harness dry from `repo`; the lines naming mutations that did not land. */
export function dryRun(
	repo: string,
	file: string
): { finished: boolean; stale: string[]; applied: number; output: string } {
	const harness = join(repo, 'ops', 'test', file);
	const text = withStubbedRuns(readFileSync(harness, 'utf8'));
	// `bash -c TEXT NAME` sets $0 to NAME, so the harness finds the repo from
	// its own path exactly as when it is run by hand — and nothing is written.
	const r = spawnSync('bash', ['-c', text, harness], {
		cwd: repo,
		encoding: 'utf8',
		timeout: 180_000,
		env: {
			...process.env,
			// Read only by a harness's precheck; the test runs are stubbed.
			TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://anchors-dry-run/none'
		}
	});
	const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
	const lines = output.split('\n');
	const stale = lines.filter((l) => /did not apply/.test(l)).map((l) => l.trim());
	// Every applied mutation is judged (stubbed, so "SURVIVED"); every harness
	// ends on its tally line.
	const applied = lines.filter((l) => /SURVIVED|— caught/.test(l)).length;
	const finished =
		r.status !== null && !/aborting/.test(output) && /(FAILED, \d+ passed|✓ all \d+)/.test(output);
	return { finished, stale, applied, output };
}

function main(): void {
	console.log('ops-harness-anchors-smoke — does every planted bug still land on the code?');
	const harnesses = mutationHarnesses();
	check(
		`found the mutation harnesses (${harnesses.length})`,
		harnesses.length >= 9,
		harnesses.join(', ')
	);

	// Self-test: the stubbing must not hide a mutation that cannot land.
	const probe = withStubbedRuns(
		[
			'mutate(){ return 3; }',
			'try(){ if ! mutate; then echo "  ✗ X — mutation did not apply"; fi; }',
			'run_tests(){ sleep 600; }',
			'try',
			"echo '✗ 1 FAILED, 0 passed'"
		].join('\n')
	);
	const self = spawnSync('bash', ['-c', probe], { encoding: 'utf8', timeout: 10_000 });
	check(
		'a mutation that cannot land is still reported, and the slow run is stubbed',
		self.status === 0 && /did not apply/.test(self.stdout ?? ''),
		`${self.stdout ?? ''}${self.stderr ?? ''}`
	);

	for (const file of harnesses) {
		const r = dryRun(REPO, file);
		if (!r.finished) {
			check(`${file} ran to its end`, false, r.output.split('\n').slice(-12).join('\n'));
			continue;
		}
		check(
			`${file}: every mutation lands on the code (${r.applied} applied)`,
			r.stale.length === 0 && r.applied > 0,
			r.stale.length > 0
				? `${r.stale.length} no longer apply — the code moved; re-anchor them:\n${r.stale.join('\n')}`
				: 'no mutation was applied at all'
		);
	}

	console.log('');
	if (failed === 0) console.log(`✓ all ${checks} ops-harness-anchors checks passed`);
	else {
		console.log(`✗ ${failed} of ${checks} ops-harness-anchors checks FAILED`);
		process.exit(1);
	}
}

main();
