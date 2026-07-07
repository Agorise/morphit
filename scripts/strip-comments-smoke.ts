/**
 * strip-comments self-test smoke (cp153).
 *
 * The shared helper at `scripts/lib/strip-comments.ts` is
 * imported by `scripts/spawn-dist-prebuild-coverage-smoke.ts`
 * (cp142).  This smoke is its dedicated regression test —
 * if `stripComments` ever silently drifts (e.g. an order-of-
 * passes refactor breaks the handling of block-and-line
 * comment interleaving), this smoke catches it before the
 * consumers do.
 *
 * Pattern: every shared helper should have a self-test smoke
 * so consumers can trust the contract without re-verifying.
 *
 * (This docblock deliberately avoids the literal `*` followed
 *  by `/` sequence inside backticks — that would close this
 *  outer docblock prematurely.)
 */

import { stripComments } from './lib/strip-comments.js';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];

function check(name: string, input: string, expected: string) {
	const actual = stripComments(input);
	if (actual === expected) {
		results.push({ name, passed: true });
	} else {
		const detail =
			'\n        input:    ' + JSON.stringify(input) +
			'\n        expected: ' + JSON.stringify(expected) +
			'\n        actual:   ' + JSON.stringify(actual);
		results.push({
			name,
			passed: false,
			detail
		});
	}
}

/* ---------------- core stripping behaviors ---------------- */

check(
	'strips a single-line // comment',
	'const x = 1; // this is a comment',
	'const x = 1; '
);

check(
	'strips a /* */ block comment on one line',
	'const x = /* inline */ 1;',
	'const x =  1;'
);

check(
	'strips a multi-line /* */ block comment',
	'before /* line 1\nline 2\nline 3 */ after',
	'before  after'
);

check(
	'strips multiple // line comments',
	'a // one\nb // two\nc // three',
	'a \nb \nc '
);

check(
	'strips multiple block comments on one line',
	'/* a */ x /* b */ y /* c */',
	' x  y '
);

check(
	'preserves code without any comments',
	'function foo(x) { return x + 1; }',
	'function foo(x) { return x + 1; }'
);

/* ---------------- subtler cases ---------------- */

check(
	'block comment containing // is stripped as a whole',
	'/* the // is inside a block comment */ x',
	' x'
);

check(
	'line comment containing /* and */ is fully stripped',
	'x // before /* not a block */ still in line',
	'x '
);

check(
	'consecutive comments without code between',
	'/* one *//* two */// three\nx',
	'\nx'
);

/* ---------------- known-limitation cases (documented) ---------------- */

// Per the helper's docblock: string literals containing comment
// markers DO get their content eaten.  This is documented as
// a known limitation; the self-test pins the current behavior
// so any future refactor that "fixes" it surfaces here as a
// deliberate decision, not an accidental change.

check(
	'string-literal // is stripped (documented limitation)',
	"const url = 'https://example.com';",
	"const url = 'https:"
);

check(
	'string-literal /* is stripped (documented limitation)',
	"const s = 'has /* in it */ inside';",
	"const s = 'has  inside';"
);

/* ---------------- empty / pathological inputs ---------------- */

check('empty input → empty output', '', '');
check('whitespace-only input passes through', '   \n  ', '   \n  ');
check('input that is entirely a comment', '// just a comment', '');
check('input that is entirely a block comment', '/* just a block */', '');

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log(`  ${ANSI_GREEN}✓${ANSI_RESET} ${r.name}`);
	} else {
		console.log(`  ${ANSI_RED}✗${ANSI_RESET} ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log(`✗ ${failed} of ${results.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(`✓ all ${results.length} scenarios passed`);
}
