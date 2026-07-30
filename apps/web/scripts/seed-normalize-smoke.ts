#!/usr/bin/env tsx
/**
 * Smoke: `normalizeSeedPhrase` strips commas (with or without spaces),
 * collapses whitespace, trims, and lowercases — the on-blur tidy applied
 * to the import seed textarea so a user who pastes "Word1, Word2, Word3"
 * (or with capitals) still gets a clean BIP-39 mnemonic.
 *
 * Tamper: drop the comma replacement or the toLowerCase → fails.
 *
 * Also covers `seedWordCount` — the gate that keeps the import "Unlock my
 * account" button disabled until exactly 12 words are present (cp338). The
 * regression this guards: the button used to enable on any non-empty text, so
 * a single pasted garbage token (e.g. "agrrtwreterwt...") counted as "filled"
 * and the button went live. seedWordCount must report 1 for that, 12 only for
 * a real 12-word phrase, and must count comma-separated input correctly.
 */
import { normalizeSeedPhrase, seedWordCount } from '../src/lib/crypto/seedNormalize.ts';

let failures = 0;
let total = 0;
function check(label: string, got: string, want: string): void {
	total++;
	if (got === want) console.log(`  ✓ ${label}`);
	else {
		console.error(`  ✗ ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
		failures++;
	}
}
function checkNum(label: string, got: number, want: number): void {
	total++;
	if (got === want) console.log(`  ✓ ${label}`);
	else {
		console.error(`  ✗ ${label}\n      got:  ${got}\n      want: ${want}`);
		failures++;
	}
}

console.log('seed-normalize smoke');
console.log('====================');

check('commas with spaces', normalizeSeedPhrase('ripple, cabin, echo'), 'ripple cabin echo');
check('commas without spaces', normalizeSeedPhrase('ripple,cabin,echo'), 'ripple cabin echo');
check('mixed commas', normalizeSeedPhrase('ripple,cabin, echo ,fox'), 'ripple cabin echo fox');
check('uppercase lowered', normalizeSeedPhrase('Ripple CABIN Echo'), 'ripple cabin echo');
check('newlines collapsed', normalizeSeedPhrase('ripple\ncabin\t echo'), 'ripple cabin echo');
check('leading/trailing trimmed', normalizeSeedPhrase('  ripple cabin echo  '), 'ripple cabin echo');
check('trailing comma', normalizeSeedPhrase('ripple cabin echo,'), 'ripple cabin echo');
check('already clean (no-op)', normalizeSeedPhrase('ripple cabin echo'), 'ripple cabin echo');

// Idempotency.
const once = normalizeSeedPhrase('Ripple, CABIN ,echo');
check('idempotent', normalizeSeedPhrase(once), once);

// seedWordCount — the import button-enable gate (cp338).
const twelve = 'ripple cabin echo fox apple zebra lemon ocean tiger maple violet sugar';
checkNum('empty → 0', seedWordCount(''), 0);
checkNum('whitespace only → 0', seedWordCount('   \n\t '), 0);
checkNum('single garbage token → 1 (the screenshot regression)', seedWordCount('agrrtwreterwtwertwerwertwert'), 1);
checkNum('11 words → 11 (button stays disabled)', seedWordCount('ripple cabin echo fox apple zebra lemon ocean tiger maple violet'), 11);
checkNum('12 words → 12 (button enabled)', seedWordCount(twelve), 12);
checkNum('13 words → 13 (button stays disabled)', seedWordCount(twelve + ' extra'), 13);
checkNum('12 comma-separated, no spaces → 12 (counts before on-blur tidy)', seedWordCount(twelve.split(' ').join(',')), 12);
checkNum('12 with commas + caps + padding → 12', seedWordCount('  Ripple, CABIN, echo,fox apple zebra lemon ocean tiger maple violet sugar  '), 12);

console.log(failures === 0 ? `\n✓ all ${total} scenarios passed` : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
