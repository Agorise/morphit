#!/usr/bin/env tsx
/**
 * smoke-pass-line-canonical-smoke
 *
 * scripts/run-smokes.sh (and Forgejo CI) tally a smoke by grepping its stdout
 * for a line starting "✓ all" and reading the integer right after "all ".
 * If a smoke instead prints "✓ all checks passed (…)" — a word, not a count —
 * the runner extracts nothing and counts the smoke as a FAILED runner, even
 * though it exited 0.
 *
 * That exact bug has shipped repeatedly (cp235 J-1/J-2, cp249
 * identicon-data-uri, cp252 rss-dynamic-title / payment-filter-shows-all-methods
 * / faq-scroll-block-start) because the author ran the smoke directly, saw a
 * "✓ all …" line, and never ran it through the runner's tally.
 *
 * The authoritative check is the runner itself (now reachable again — the
 * chunked runner's hardcoded tsx path was repaired this checkpoint). This
 * guard is a fast, precise STATIC complement that flags the one recurring
 * anti-pattern at the per-smoke level: a console.log whose literal begins
 * (at column 0, optionally after a leading \n) with "✓ all " followed by a
 * letter instead of a digit or a count interpolation.
 *
 * It deliberately does NOT model every runtime-constructed pass line
 * (ternaries, concatenations, indented progress lines, contract docs in
 * comments) — that path is a JS interpreter and produces false positives.
 * Anything subtler than the anti-pattern is left to the runner.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');
const thisFile = fileURLToPath(import.meta.url);

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ''): void {
	checks++;
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
	}
}

/**
 * Returns offending fragments: console.log literals that begin (column 0,
 * optional leading \n) with "✓ all " immediately followed by a letter — i.e.
 * a non-canonical pass line the runner cannot tally. \u2713 is normalised to ✓
 * (several smokes encode the tick that way). No leading whitespace is allowed
 * before ✓, so indented per-check lines ("  ✓ …") are correctly ignored, as
 * are ✓-all mentions inside comments (not inside a console.log call).
 */
export function nonCanonicalPassLines(source: string): string[] {
	const normalised = source.replace(/\\u2713/g, '✓');
	const re = /console\.(?:log|info)\(\s*([`'"])((?:\\n)?✓ all [^`'"]*)\1/g;
	const bad: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(normalised)) !== null) {
		const body = m[2].replace(/^\\n/, '');
		const after = body.slice('✓ all '.length);
		if (/^[A-Za-z]/.test(after)) bad.push(m[2]);
	}
	return bad;
}

console.log('\n── anti-pattern detector self-tests ───────────────────');
check('flags "all checks passed"', nonCanonicalPassLines("console.log(`✓ all checks passed (10 locales)`)").length === 1);
check('flags \\u2713-escaped "all checks"', nonCanonicalPassLines("console.log(`\\u2713 all checks passed`)").length === 1);
check('flags leading-\\n "all foo"', nonCanonicalPassLines("console.log(`\\n✓ all foo passed`)").length === 1);
check('passes interpolated count', nonCanonicalPassLines("console.log(`✓ all ${n} foo scenarios passed`)").length === 0);
check('passes literal count', nonCanonicalPassLines("console.log(`✓ all 42 foo scenarios passed`)").length === 0);
check('ignores indented progress line', nonCanonicalPassLines("console.log('  ✓ all narrow unions cover the set')").length === 0);
check('ignores all-mention in a comment', nonCanonicalPassLines("// emits `✓ all N scenarios passed`\nconsole.log(`✓ all ${n} ok`)").length === 0);
check('ignores ternary emit', nonCanonicalPassLines("console.log(`\\n${c ? '✓ all' : '✗'} ${n} scenarios passed`)").length === 0);

console.log('\n── registered smokes (anti-pattern scan) ──────────────');
const runner = readFileSync(resolve(repo, 'scripts/run-smokes.sh'), 'utf-8');
const entries = runner
	.split('\n')
	.map((l) => l.match(/^\s*"([^"]+:[^"]+)"\s*$/))
	.filter((x): x is RegExpMatchArray => x !== null)
	.map((x) => x[1]);
check('found a non-trivial SMOKES list', entries.length > 250, `got ${entries.length}`);

let offenders = 0;
for (const entry of entries) {
	const i = entry.indexOf(':');
	const path = resolve(repo, entry.slice(0, i), 'scripts', `${entry.slice(i + 1)}.ts`);
	if (!existsSync(path)) continue;
	if (path === thisFile) continue; // our own self-tests embed the anti-pattern by design
	const bad = nonCanonicalPassLines(readFileSync(path, 'utf-8'));
	if (bad.length > 0) {
		offenders++;
		console.log(`  ✗ ${entry} — non-canonical pass line: ${JSON.stringify(bad[0])}`);
	}
}
check('no registered smoke emits a non-canonical pass line', offenders === 0, `${offenders} offender(s)`);

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} smoke-pass-line-canonical scenarios passed (${entries.length} registered smokes scanned)`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
