/**
 * account-suggestion-smoke.ts (cp600) — pins suggestAccountBase, which turns
 * the operator's instance name (or domain) into a relay/fees account-name
 * SUGGESTION (e.g. "Morphit NL" -> "morphitnl" -> @morphitnl-relay / -fees).
 * The suggestion must stay Blurt-name-safe: `<base>-relay` and `<base>-fees`
 * must both fit Blurt's 16-char account-name limit.
 */
import { suggestAccountBase } from '../src/init/steps.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

console.log('\u2500\u2500 account-suggestion smoke (cp600) \u2500\u2500\u2500\u2500');

// Ken's examples.
check('"Morphit NL" -> "morphitnl"', suggestAccountBase('Morphit NL') === 'morphitnl');
check('"morphit.io" -> "morphitio"', suggestAccountBase('morphit.io') === 'morphitio');

// Strips case, spaces, punctuation.
check('strips case/spaces/punctuation ("Trade-Hub! 2000" -> "tradehub20")', suggestAccountBase('Trade-Hub! 2000') === 'tradehub20');

// Capped at 10 so `<base>-relay` / `<base>-fees` fit Blurt's 16-char limit.
const longBase = suggestAccountBase('Morphit Netherlands Community');
check('caps a long name at 10 chars', longBase.length === 10);
check('`<base>-relay` fits 16 chars', (longBase + '-relay').length <= 16);
check('`<base>-fees` fits 16 chars', (longBase + '-fees').length <= 16);

// Unusable input -> '' (caller shows a generic placeholder).
check('empty -> "" (generic fallback)', suggestAccountBase('') === '');
check('digits-only / no leading letter -> ""', suggestAccountBase('42') === '' && suggestAccountBase('7-eleven') === '');
check('punctuation-only -> ""', suggestAccountBase('!!!') === '');
check('single char -> "" (too short)', suggestAccountBase('A') === '');

// A usable base is lowercase and starts with a letter (valid Blurt start).
const b = suggestAccountBase('Morphit NL');
check('usable base is lowercase + starts with a letter', /^[a-z][a-z0-9]*$/.test(b));

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} account-suggestion checks passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failed} of ${passed + failed} account-suggestion checks failed`);
	process.exit(1);
}
