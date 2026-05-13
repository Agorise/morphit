/**
 * splitOnPlaceholder smoke.
 *
 * Validates the i18n placeholder-split helper used by the
 * daily-ceiling voucher-path UI in
 * apps/web/src/routes/onboarding/register-name/+page.svelte
 * (and any future caller that needs the same pattern).
 *
 * Coverage:
 *   - Happy path: tokens present and ordered → 3-tuple
 *     [before, linkText, after].
 *   - Token preservation through real translation strings
 *     (positional reordering by translators).
 *   - Graceful degradation: missing open token, missing
 *     close token, reversed order, both missing — all
 *     return the input as `[whole, '', '']` so the UI
 *     renders plain text instead of breaking.
 *   - Edge cases: empty input, empty link text between
 *     adjacent tokens, tokens at start / end of string,
 *     non-ASCII content (Persian RTL, Chinese), tokens
 *     used as substrings of larger text.
 *
 * Design rationale: the helper is the trust boundary
 * between translator-supplied text and DOM construction.
 * If a translator drops a placeholder by mistake, we want
 * a degraded-but-readable result, NOT a runtime crash or
 * a broken layout.
 *
 * Usage:
 *   tsx apps/web/scripts/split-on-placeholder-smoke.ts
 */

import { splitOnPlaceholder } from '../src/lib/utils/splitOnPlaceholder.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.error(`  ✗ ${name}`);
		console.error(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function expect(actual: unknown, expected: unknown, label = ''): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label ? label + ': ' : ''}expected ${e}, got ${a}`);
	}
}

console.log('splitOnPlaceholder smoke:\n');

// ─── Happy path ──────────────────────────────────────────────

scenario('tokens present and ordered → 3-tuple split', () => {
	const r = splitOnPlaceholder(
		'Join us in {open}#agorise:matrix.org{close} for help.',
		'{open}',
		'{close}'
	);
	expect(r, ['Join us in ', '#agorise:matrix.org', ' for help.']);
});

scenario('English translation preserves link position mid-sentence', () => {
	const text =
		'Join us in the Agorise Matrix room {matrix_open}#agorise:matrix.org{matrix_close}. A community member will give you a voucher code.';
	const r = splitOnPlaceholder(text, '{matrix_open}', '{matrix_close}');
	expect(r[0], 'Join us in the Agorise Matrix room ');
	expect(r[1], '#agorise:matrix.org');
	expect(r[2], '. A community member will give you a voucher code.');
});

scenario('translator reorders sentence — link at start', () => {
	const text =
		'{plugin_open}blurtplugin.online/account{plugin_close} — open this URL, paste your voucher.';
	const r = splitOnPlaceholder(text, '{plugin_open}', '{plugin_close}');
	expect(r[0], '');
	expect(r[1], 'blurtplugin.online/account');
	expect(r[2], ' — open this URL, paste your voucher.');
});

scenario('translator reorders sentence — link at end', () => {
	const text = 'Click here: {plugin_open}blurtplugin.online/account{plugin_close}';
	const r = splitOnPlaceholder(text, '{plugin_open}', '{plugin_close}');
	expect(r[0], 'Click here: ');
	expect(r[1], 'blurtplugin.online/account');
	expect(r[2], '');
});

// ─── Real translations ───────────────────────────────────────

scenario('Persian (RTL) translation preserves split order', () => {
	const text =
		'به اتاق Matrix Agorise بپیوندید: {matrix_open}#agorise:matrix.org{matrix_close}. یکی از اعضای جامعه به شما یک کد ووچر می‌دهد.';
	const r = splitOnPlaceholder(text, '{matrix_open}', '{matrix_close}');
	expect(r[1], '#agorise:matrix.org');
	// Before/after both contain Persian text.
	if (!r[0].includes('Matrix')) {
		throw new Error(`expected 'Matrix' in before, got: ${r[0]}`);
	}
	if (!r[2].includes('کد')) {
		throw new Error(`expected Persian after-text, got: ${r[2]}`);
	}
});

scenario('Simplified Chinese translation preserves split order', () => {
	const text =
		'加入我们的 Agorise Matrix 房间 {matrix_open}#agorise:matrix.org{matrix_close}。社区成员会给你一个 voucher 码。';
	const r = splitOnPlaceholder(text, '{matrix_open}', '{matrix_close}');
	expect(r[1], '#agorise:matrix.org');
	if (!r[0].includes('房间')) {
		throw new Error(`expected Chinese before-text, got: ${r[0]}`);
	}
});

// ─── Graceful degradation ────────────────────────────────────

scenario('missing open token → [whole, "", ""]', () => {
	const text = 'Translator dropped the open marker {close}#agorise:matrix.org';
	const r = splitOnPlaceholder(text, '{open}', '{close}');
	expect(r, [text, '', '']);
});

scenario('missing close token → [whole, "", ""]', () => {
	const text = 'Translator dropped the close marker {open}#agorise:matrix.org';
	const r = splitOnPlaceholder(text, '{open}', '{close}');
	expect(r, [text, '', '']);
});

scenario('both tokens missing → [whole, "", ""]', () => {
	const text = 'No placeholders at all in this string.';
	const r = splitOnPlaceholder(text, '{open}', '{close}');
	expect(r, [text, '', '']);
});

scenario('reversed order (close before open) → [whole, "", ""]', () => {
	// Translator put the placeholders backwards.
	const text = 'Backwards: {close}link{open} text.';
	const r = splitOnPlaceholder(text, '{open}', '{close}');
	expect(r, [text, '', '']);
});

scenario('open and close are the same position (impossible — close is open) → degraded', () => {
	// Edge case where the open and close strings happen to be
	// identical.  indexOf finds the same index for both, which
	// fails the `c <= o` guard (c === o).
	const text = 'A{X}link{X}B';
	const r = splitOnPlaceholder(text, '{X}', '{X}');
	expect(r, [text, '', '']);
});

// ─── Edge cases ──────────────────────────────────────────────

scenario('empty input → ["", "", ""]', () => {
	const r = splitOnPlaceholder('', '{open}', '{close}');
	expect(r, ['', '', '']);
});

scenario('empty link text (adjacent tokens) → ["", "", "rest"]', () => {
	const r = splitOnPlaceholder('{open}{close}rest', '{open}', '{close}');
	expect(r, ['', '', 'rest']);
});

scenario('whole string is the link', () => {
	const r = splitOnPlaceholder('{open}link{close}', '{open}', '{close}');
	expect(r, ['', 'link', '']);
});

scenario('multi-character tokens with special regex chars', () => {
	// indexOf is plain-string, not regex, so {} and others
	// don't need escaping.  This is intentional — we don't
	// want translators thinking about regex.
	const r = splitOnPlaceholder('a[[b]]c', '[[', ']]');
	expect(r, ['a', 'b', 'c']);
});

scenario('token literal appears multiple times — uses first occurrence', () => {
	// indexOf returns the first match.  If a translator
	// accidentally wrote the open token twice, we use the
	// first; everything between the first open and the first
	// close becomes the link text, even if that includes a
	// stray duplicate token.  This is the "least surprising"
	// behavior: degraded but predictable.
	const r = splitOnPlaceholder('A{open}first{open}second{close}B', '{open}', '{close}');
	expect(r, ['A', 'first{open}second', 'B']);
});

scenario('close token appears before any open — returns degraded', () => {
	// Real-world case: translator wrote
	// "before {close}…{open}link{close} after"
	// — the first {close} comes before any {open}.
	const text = 'Pre-{close}garbage{open}link{close}-post';
	const r = splitOnPlaceholder(text, '{open}', '{close}');
	// First {close} is at index 4, first {open} is at index
	// 18; c < o means our guard fires and we degrade.  Good:
	// trying to recover from this is ambiguous.
	expect(r, [text, '', '']);
});

scenario('non-ASCII tokens work', () => {
	// Hypothetical: someone uses Unicode placeholders.
	const r = splitOnPlaceholder('hello «link» world', '«', '»');
	expect(r, ['hello ', 'link', ' world']);
});

// ─── Idempotency / round-trip ────────────────────────────────

scenario('reassembling [before+token+linkText+token+after] === original', () => {
	const original = 'one {open}two{close} three';
	const [before, link, after] = splitOnPlaceholder(original, '{open}', '{close}');
	const reassembled = `${before}{open}${link}{close}${after}`;
	expect(reassembled, original);
});

console.log(
	`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} scenarios passed`
);
process.exit(failures === 0 ? 0 : 1);
