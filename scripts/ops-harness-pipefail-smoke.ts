/**
 * ops-harness-pipefail-smoke (v1.20.0 deep review, wave 2).
 *
 * Every ops/test harness runs under `set -o pipefail`. In that mode
 * `printf '%s' "$out" | grep -q PATTERN` stops reading at the first match,
 * the writer dies of SIGPIPE (exit 141), and the whole test reads "no match".
 * Whether that happens depends on the output's size and on timing. So a
 * mutation the smoke really caught was reported as "the smoke failed, but not
 * for the expected reason" (fastchat-instance-matrix Q6, reproduced), and a
 * verdict could flip the same way. The harnesses now feed grep -q a
 * here-string, which has no writer process to kill.
 *
 * This smoke:
 *  1. proves the hazard in real bash, so the rule below guards a real
 *     failure: a big output whose first line matches is "no match" through
 *     the pipe and "match" through a here-string;
 *  2. self-tests the detector on both shapes;
 *  3. asserts that no harness under ops/test that sets pipefail pipes into
 *     `grep -q` / `grep --quiet`.
 * MORPHIT_OPS_TEST_ROOT=<dir containing ops/test> checks another tree.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.env.MORPHIT_OPS_TEST_ROOT ?? join(__dirname, '..'));
const DIR = join(ROOT, 'ops', 'test');

let pass = 0;
let fail = 0;
const ok = (m: string): void => {
	pass++;
	console.log(`  ✓ ${m}`);
};
const bad = (m: string): void => {
	fail++;
	console.log(`  ✗ ${m}`);
};

/** A pipe INTO an early-exit grep (not a comment). */
export function pipesIntoQuietGrep(line: string): boolean {
	const code = line.replace(/(^|\s)#.*$/, '');
	// A single `|` (a pipe), never the `||` of an or-list.
	return /(?<!\|)\|(?!\|)\s*grep\s+(?:-[A-Za-z]*q[A-Za-z]*|--quiet)\b/.test(code);
}

console.log('ops-harness-pipefail-smoke');

// 1. The hazard is real.
const bash = (script: string): number | null =>
	spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 }).status;
const big = `out="$(printf 'Tests  3 failed\\n'; for i in $(seq 1 20000); do printf 'filler line %d padding padding\\n' $i; done)"`;
const piped = bash(
	`set -o pipefail; ${big}; printf '%s' "$out" | grep -qE 'Tests +[0-9]+ failed' && exit 0 || exit 1`
);
const here = bash(
	`set -o pipefail; ${big}; grep -qE 'Tests +[0-9]+ failed' <<<"$out" && exit 0 || exit 1`
);
if (piped === 1 && here === 0)
	ok(
		'under pipefail a real match reads "no match" through printf | grep -q, and "match" through a here-string'
	);
else bad(`the hazard did not reproduce (pipe exit ${piped}, here-string exit ${here})`);

// 2. The detector.
const shapes: [string, boolean][] = [
	[`\tif printf '%s' "$1" | grep -q 'FAILED'; then echo fail`, true],
	[`\tif [ -z "$n" ] || printf '%s\\n' "$out" | grep '✗' | grep -qi -- "$n"; then`, true],
	[`\tif ! printf '%s' "$OUT" | grep --quiet '^PASS'; then`, true],
	[`\tif grep -q 'FAILED' <<<"$1"; then echo fail`, false],
	[`\tgrep -qi -- "$n" <<<"$(grep '✗' <<<"$out")"`, false],
	[`# e.g. printf '%s' "$x" | grep -q y  (a comment)`, false],
	[`\tout="$(run | grep -v '^$')"`, false],
	[`\tif [ -z "$n" ] || grep -qi -- "$n" <<<"$x"; then`, false]
];
const wrong = shapes.filter(([l, want]) => pipesIntoQuietGrep(l) !== want);
if (wrong.length === 0)
	ok(
		`the detector flags the ${shapes.filter((s) => s[1]).length} unsafe shapes and passes the safe ones`
	);
else bad(`the detector is wrong on: ${wrong.map((w) => JSON.stringify(w[0])).join(' | ')}`);

// 3. The harnesses.
const files = readdirSync(DIR).filter((f) => f.endsWith('.sh'));
let checked = 0;
for (const f of files) {
	const text = readFileSync(join(DIR, f), 'utf8');
	if (!/set -[a-z]*o pipefail|set -o pipefail/.test(text)) continue;
	checked++;
	const hits = text
		.split('\n')
		.map((l, i) => [l, i + 1] as const)
		.filter(([l]) => pipesIntoQuietGrep(l));
	if (hits.length === 0) ok(`ops/test/${f}: no pipe into grep -q`);
	else
		bad(
			`ops/test/${f}: pipes into grep -q under pipefail (a real match can read "no match") at line ${hits.map((h) => h[1]).join(', ')}`
		);
}
if (checked === 0) bad(`no pipefail harness found under ${DIR}`);

console.log(
	fail === 0
		? `\n✓ all ${pass} ops-harness-pipefail checks passed`
		: `\n✗ ${fail} FAILED, ${pass} passed`
);
process.exit(fail === 0 ? 0 : 1);
