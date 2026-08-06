#!/usr/bin/env tsx
/**
 * Smoke for accountNumberDetector.
 *
 * Validates that the Tier 2.1 chat-composer reminder fires
 * for the message shapes that contain payment-routing
 * identifiers, and DOES NOT fire on regular chat prose,
 * dates, prices, ID-ish strings without enough digits, etc.
 *
 * The detector is INFORMATIONAL — false positives just
 * trigger a dismissable reminder and false negatives let
 * an account-number typo through.  The smoke errs on the
 * "warn more" side: it's fine if "let me check 2026-05-09"
 * triggers (the user dismisses it once per session); it's
 * NOT fine if "my IBAN is DE89370400440532013000" doesn't.
 */

import {
	detectAccountNumbers,
	hasAccountNumberShape,
	type AccountNumberMatchKind
} from '../src/lib/security/accountNumberDetector';

interface Scenario {
	readonly name: string;
	readonly input: string;
	readonly expectMatch: boolean;
	readonly expectKinds?: readonly AccountNumberMatchKind[];
}

const scenarios: readonly Scenario[] = [
	// ─── Should fire ─────────────────────────────────────
	{
		name: 'IBAN — German',
		input: 'Send to DE89370400440532013000 thanks',
		expectMatch: true,
		expectKinds: ['iban']
	},
	{
		name: 'IBAN — French',
		input: 'IBAN: FR1420041010050500013M02606',
		expectMatch: true,
		expectKinds: ['iban']
	},
	{
		name: 'IBAN lowercase',
		input: 'my iban is gb82west12345698765432 ok',
		expectMatch: true,
		expectKinds: ['iban']
	},
	{
		name: 'US bank account number — 10 digits',
		input: 'my account is 1234567890',
		expectMatch: true,
		expectKinds: ['digit_run']
	},
	{
		name: 'Card-shaped — 16 digits with spaces',
		input: '4111 1111 1111 1111 expires 12/26',
		expectMatch: true,
		expectKinds: ['digit_run']
	},
	{
		name: 'Card-shaped — hyphen separators',
		input: '4111-1111-1111-1111',
		expectMatch: true,
		expectKinds: ['digit_run']
	},
	{
		name: 'SWIFT/BIC — 8 chars',
		input: 'BIC code is DEUTDEFF',
		expectMatch: true,
		expectKinds: ['swift_bic']
	},
	{
		name: 'SWIFT/BIC — 11 chars',
		input: 'BIC: DEUTDEFF500',
		expectMatch: true,
		expectKinds: ['swift_bic']
	},
	{
		name: 'Routing + account combo',
		input: 'routing 071000013 account 12345678',
		expectMatch: true,
		expectKinds: ['digit_run']
	},
	{
		name: 'Mixed IBAN and BIC in one message',
		input: 'IBAN DE89370400440532013000 BIC DEUTDEFFXXX',
		expectMatch: true
	},

	// ─── Should NOT fire ─────────────────────────────────
	{
		name: 'plain greeting',
		input: 'hello, how are you?',
		expectMatch: false
	},
	{
		name: 'price discussion',
		input: 'I can do $50 USD or 0.001 BTC',
		expectMatch: false
	},
	{
		name: '8-digit date YYYYMMDD',
		input: 'meeting on 20260509 ok',
		expectMatch: false
	},
	{
		name: 'short order ID',
		input: 'order id 1234',
		expectMatch: false
	},
	{
		name: 'mnemonic-like words (not account)',
		input: 'apple banana cherry',
		expectMatch: false
	},
	{
		name: 'hex-like blob too short for SWIFT',
		input: 'ref abc123',
		expectMatch: false
	},
	{
		name: 'lowercase 8-char alphanumeric (not BIC)',
		input: 'see thread1234',
		expectMatch: false
	},
	{
		name: 'crypto address shape (BTC) — out of scope here',
		input: 'send to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
		// IBAN regex requires 2-letter country + 2 digits + 11+
		// alphanumeric.  bc1q has digits 2-3 (1 + 'q'... wait
		// 'q' is a letter), so bc1qxy2k... starts bc + 1q —
		// '1q' is digit+letter, not 2 digits.  Should NOT match
		// IBAN.  And it has digits but they aren't a 9-digit
		// connected run.
		expectMatch: false
	},
	{
		name: 'phone number — 10 digits, hyphenated',
		input: 'call me at 555-123-4567',
		// Phone numbers look like account numbers under our
		// detector — that's intentional per the doc comment.
		// We WARN on phone numbers, even though they're often
		// legitimate; the user dismisses once per session.
		expectMatch: true,
		expectKinds: ['digit_run']
	},
	{
		name: 'empty string',
		input: '',
		expectMatch: false
	},
	{
		name: 'whitespace only',
		input: '   \n\t   ',
		expectMatch: false
	}
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const s of scenarios) {
	const matches = detectAccountNumbers(s.input);
	const hasShape = hasAccountNumberShape(s.input);
	const ok =
		hasShape === s.expectMatch &&
		matches.length > 0 === s.expectMatch &&
		(s.expectKinds === undefined ||
			s.expectKinds.every((k) => matches.some((m) => m.kind === k)));
	if (ok) {
		passed++;
	} else {
		failed++;
		failures.push(
			`  ✗ ${s.name}\n` +
				`    input: ${JSON.stringify(s.input)}\n` +
				`    expect match=${s.expectMatch}` +
				(s.expectKinds ? ` kinds=[${s.expectKinds.join(',')}]` : '') +
				'\n' +
				`    got hasShape=${hasShape} matches=${JSON.stringify(matches)}`
		);
	}
}

console.log('');
console.log('── account-number detector smoke ───────────────────────');
console.log('');
if (failed === 0) {
	console.log(`  ✓ all ${passed} scenarios passed`);
	console.log('');
	console.log('────────────────────────────────────────────────────────');
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	console.log(`  ${passed} passed, ${failed} failed`);
	console.log('');
	console.log(failures.join('\n'));
	console.log('');
	console.log('────────────────────────────────────────────────────────');
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}
