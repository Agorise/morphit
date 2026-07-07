#!/usr/bin/env tsx
/**
 * vapid-key-validation-smoke (cp404).
 *
 * The relay serves MORPHIT_RELAY_VAPID_PUBLIC_KEY verbatim to clients as
 * pushManager.subscribe()'s applicationServerKey. A malformed key (wrong
 * length, a stray trailing newline that survives into the served JSON, a
 * base64-PEM blob, or the 32-byte PRIVATE key pasted in by mistake) makes
 * subscribe() throw in EVERY user's browser, surfacing as an
 * undiagnosable "Subscription failed" (the exact bug reported for
 * kentest3). This smoke locks:
 *   - isValidVapidPublicKey() accepts only a 65-byte 0x04 P-256 point,
 *   - pushEnabled requires a VALID public key (not merely a set one),
 *   - the VAPID env vars are trimmed (so a copy-paste newline can't sneak
 *     into the served key),
 *   - main.ts logs a clear operator warning for the set-but-invalid case.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidVapidPublicKey } from '../src/config/index.ts';

let scenarios = 0;
let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
	scenarios++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		failures++;
		console.log(`  \u2717 ${name}`);
		if (detail) console.log(`      ${detail}`);
	}
};

// A syntactically valid (shape-only) VAPID public key: 65 bytes, leading
// 0x04, base64url-encoded.
const VALID = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url');

check('1 accepts a well-formed 65-byte 0x04 base64url key', isValidVapidPublicKey(VALID), VALID);
check('2 rejects a 32-byte value (private-key length pasted in)', !isValidVapidPublicKey(Buffer.alloc(32, 9).toString('base64url')));
check('3 rejects a 65-byte point with wrong leading byte (0x03)', !isValidVapidPublicKey(Buffer.concat([Buffer.from([0x03]), Buffer.alloc(64, 7)]).toString('base64url')));
check('4 rejects a trailing newline', !isValidVapidPublicKey(VALID + '\n'));
check('5 rejects surrounding whitespace', !isValidVapidPublicKey(' ' + VALID + ' '));
check('6 rejects PEM armor', !isValidVapidPublicKey('-----BEGIN PUBLIC KEY-----\nMFkwE...\n-----END PUBLIC KEY-----'));
check('7 rejects a raw hex string', !isValidVapidPublicKey('04' + 'ab'.repeat(64)));
check('8 rejects empty / undefined / null', !isValidVapidPublicKey('') && !isValidVapidPublicKey(undefined) && !isValidVapidPublicKey(null));

// ── Source wiring assertions ───────────────────────────────
const cfgSrc = readFileSync(fileURLToPath(new URL('../src/config/index.ts', import.meta.url)), 'utf-8');
const mainSrc = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf-8');

check(
	'9 pushEnabled gates on isValidVapidPublicKey (not merely a set key)',
	/pushEnabled:\s*Boolean\(\s*isValidVapidPublicKey\(/.test(cfgSrc)
);
check(
	'10 VAPID public key env var is trimmed',
	/MORPHIT_RELAY_VAPID_PUBLIC_KEY:\s*z\.string\(\)\.trim\(\)/.test(cfgSrc)
);
check(
	'11 main.ts warns the operator on a set-but-invalid VAPID key',
	mainSrc.includes('vapid_public_key_invalid')
);

console.log(`\n${'\u2500'.repeat(56)}`);
if (failures === 0) {
	console.log(`\u2713 all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
