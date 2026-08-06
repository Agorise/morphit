#!/usr/bin/env tsx
/**
 * public-key-display-smoke (cp404).
 *
 * Pins the centralized public-key truncation (crypto/publicKeyDisplay.ts)
 * that replaced the inline head-9…tail-4 slice duplicated in IdentityLabel
 * (and now reused by order cards). The shape MUST stay "BLT<6>…<4>" so the
 * abbreviation is identical everywhere it appears.
 */

import { truncatePublicKey, _clearTruncatePublicKeyCache } from '../src/lib/crypto/publicKeyDisplay';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

_clearTruncatePublicKeyCache();

// Canonical ~53-char base58 BLT key.
const KEY = 'BLT5vwABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghij7Bjw';

// 1. head-9 … tail-4 with the ellipsis.
{
	const out = truncatePublicKey(KEY);
	if (out === `${KEY.slice(0, 9)}\u2026${KEY.slice(-4)}`) ok(`1 truncates head-9…tail-4 ("${out}")`);
	else bad('1 truncation shape', out);
}

// 2. Uses the single-char ellipsis (…), not three dots.
{
	const out = truncatePublicKey(KEY);
	if (out.includes('\u2026') && !out.includes('...')) ok('2 uses the … ellipsis glyph, not "..."');
	else bad('2 ellipsis glyph', out);
}

// 3. Short placeholder (≤14) shown whole.
{
	if (truncatePublicKey('BLT02cd…a6d3') === 'BLT02cd…a6d3') ok('3 ≤14-char value shown whole');
	else bad('3 short whole');
	if (truncatePublicKey('BLT123') === 'BLT123') ok('3b tiny value shown whole');
	else bad('3b tiny whole');
}

// 4. Empty / null / undefined → '' (callers render nothing).
{
	if (truncatePublicKey('') === '' && truncatePublicKey(null) === '' && truncatePublicKey(undefined) === '')
		ok("4 empty/null/undefined → ''");
	else bad('4 empty guard');
}

// 5. Idempotent + memoized (same input, same output; second call is cached).
{
	const a = truncatePublicKey(KEY);
	const b = truncatePublicKey(KEY);
	if (a === b) ok('5 idempotent (memoized) for repeat calls');
	else bad('5 idempotence', `${a} vs ${b}`);
}

// 6. Cache eviction never corrupts output: after clearing, still correct.
{
	_clearTruncatePublicKeyCache();
	const out = truncatePublicKey(KEY);
	if (out === `${KEY.slice(0, 9)}\u2026${KEY.slice(-4)}`) ok('6 correct after cache clear');
	else bad('6 post-clear', out);
}

// 7. Matches the shape IdentityLabel used to inline (regression anchor).
{
	let src = '';
	try {
		src = readFileSync(
			fileURLToPath(new URL('../src/lib/components/IdentityLabel.svelte', import.meta.url)),
			'utf-8'
		);
	} catch {
		src = '';
	}
	if (src.includes('truncatePublicKey(') && !src.includes('`${f.slice(0, 9)}…${f.slice(-4)}`'))
		ok('7 IdentityLabel delegates to the centralized util (inline slice removed)');
	else bad('7 IdentityLabel still inlines the slice');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 public-key-display smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} public-key-display scenarios passed`);
