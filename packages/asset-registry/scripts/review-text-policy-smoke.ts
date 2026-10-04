/**
 * review-text-policy-smoke — the shared review text policy
 * (FORBIDDEN_REVIEW_TEXT_CHARS, MAX_REVIEW_COMMENT_CODEPOINTS) refuses every
 * invisible or direction-changing character the indexer refuses, and accepts
 * ordinary multilingual text and emoji.
 *
 * Usage: tsx packages/asset-registry/scripts/review-text-policy-smoke.ts
 */
import { reviewCommentProblem } from '../src/index.ts';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean): void => {
	if (ok) pass++;
	else fail++;
	console.log(`  ${ok ? '✓' : '✗'} ${name}`);
};

const REFUSED: [string, number][] = [
	['NUL', 0x0000],
	['newline', 0x000a],
	['DEL', 0x007f],
	['C1 NEL', 0x0085],
	['zero-width space', 0x200b],
	['line separator', 0x2028],
	['paragraph separator', 0x2029],
	['LRE', 0x202a],
	['RLO', 0x202e],
	['word joiner', 0x2060],
	['invisible plus', 0x2064],
	['LRI', 0x2066],
	['PDI', 0x2069],
	['BOM', 0xfeff]
];
for (const [name, cp] of REFUSED) {
	check(
		`refuses ${name} (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`,
		reviewCommentProblem(`ok${String.fromCodePoint(cp)}ok`) === 'forbidden_chars'
	);
}
for (const text of [
	'Great trade, fast payment!',
	'Très bien — merci',
	'تاجر ممتاز',
	'非常好的交易',
	'good 👍🏽 deal',
	'خیلی خوب بود'
]) {
	check(`accepts "${text}"`, reviewCommentProblem(text) === null);
}
check(
	'256 emoji is within the limit (code points, not UTF-16 units)',
	reviewCommentProblem('👍'.repeat(256)) === null
);
check('257 characters is too long', reviewCommentProblem('a'.repeat(257)) === 'too_long');

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} review-text-policy checks passed`);
} else {
	console.log(`✗ ${fail} of ${pass + fail} review-text-policy checks failed`);
	process.exit(1);
}
