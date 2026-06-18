#!/usr/bin/env tsx
/**
 * Smoke: `normalizeSeedPhrase` strips commas (with or without spaces),
 * collapses whitespace, trims, and lowercases — the on-blur tidy applied
 * to the import seed textarea so a user who pastes "Word1, Word2, Word3"
 * (or with capitals) still gets a clean BIP-39 mnemonic.
 *
 * Tamper: drop the comma replacement or the toLowerCase → fails.
 */
import { normalizeSeedPhrase } from '../src/lib/crypto/seedNormalize.ts';

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

console.log(failures === 0 ? `\n✓ all ${total} scenarios passed` : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
