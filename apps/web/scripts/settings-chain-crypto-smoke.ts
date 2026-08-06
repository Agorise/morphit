#!/usr/bin/env tsx
/*
 * settings-chain-crypto — v1.5.0 (tt.txt J) guard.
 *
 * The settings-to-chain feature mirrors a user's settings (notifications,
 * quiet hours, privacy, syndication, hidden/blocked accounts, preferences)
 * to a PUBLIC, PERMANENT chain, encrypted with a posting-key-derived key.
 * It shipped with NO test at all — so nothing proved the blob actually
 * round-trips, that a wrong key is rejected, or that tampering is caught.
 * A silent break here either loses a user's settings forever or, far worse,
 * publishes them readably.
 *
 * These are FUNCTIONAL tests — they call the real encrypt/decrypt, not a
 * source scan.
 *
 * They also pin the lazy libsodium import: this module is reachable from the
 * shared [lang] layout (layout → settingsSync → settingsCrypto), so a static
 * `import sodium from 'libsodium-wrappers-sumo'` here drags ~1 MB into EVERY
 * page's preload closure. v1.5.0 shipped exactly that regression; cp471
 * fixed it by routing through $crypto/sodium. libsodium-not-in-baseline-
 * closure-smoke guards the closure; this pins the cause at the source.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encryptSettingsState, decryptSettingsState } from '../src/lib/settings/settingsCrypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');

let pass = 0;
let fail = 0;
function ok(msg: string): void {
	pass++;
	console.log(`  ✓ ${msg}`);
}
function bad(scope: string, msg: string): void {
	fail++;
	console.log(`  ✗ ${scope}: ${msg}`);
}

/** Deterministic 32-byte fake posting private key. */
function key(seed: number): Uint8Array {
	const k = new Uint8Array(32);
	for (let i = 0; i < 32; i++) k[i] = (seed + i * 7) & 0xff;
	return k;
}

/*
 * Long, unique canary values — NOT short ones like 'MXN'.
 *
 * cp471: the confidentiality check below originally searched for 'MXN' (3
 * chars) in the base64 BLOB TEXT, and it was wrong in BOTH directions:
 *
 *   FALSE POSITIVE — ciphertext base64 is effectively random text over a
 *   64-char alphabet, so a 3-char needle collides by pure chance in a ~228
 *   char blob about 1 run in 1000 (measured: 3/3000). CI's triple-pulse duly
 *   caught it: two pulses green, the third red on a blob that was perfectly
 *   encrypted.
 *
 *   FALSE NEGATIVE (the serious one) — base64 re-encodes each 3 bytes into 4
 *   chars, so plaintext sitting IN the blob does not survive as a literal
 *   substring of the base64: a blob containing {"preferences":{"fiat":"MXN"}}
 *   verbatim contains no 'MXN' in its base64 at ANY of the 3 byte alignments
 *   (verified). The check could therefore MISS a total plaintext leak — the
 *   exact catastrophe it exists to catch.
 *
 * The fix is both halves: DECODE the blob to raw bytes and search THOSE, and
 * use needles long enough that a random collision is impossible (a 20+ char
 * needle in ~170 random bytes has probability ~256^-20).
 */
const CANARY_FIAT = 'CANARY_FIAT_c9f24a7b1e8d42';
const CANARY_HIDDEN = 'CANARY_HIDDEN_5b1e07d3a64299';

const STATE = {
	notifications: { enabled: true, quietHours: { from: '22:00', to: '07:00' } },
	hidden: [CANARY_HIDDEN],
	preferences: { fiat: CANARY_FIAT, region: 'MX' }
};

async function main(): Promise<void> {
	// ── 1. Round-trip ────────────────────────────────────────────────
	const blob = await encryptSettingsState(key(1), 'kentest2', STATE);
	const back = await decryptSettingsState(key(1), 'kentest2', blob);
	if (JSON.stringify(back) === JSON.stringify(STATE)) {
		ok('round-trip: encrypt → decrypt returns the exact settings state');
	} else {
		bad('round-trip', `settings did not survive the round trip: got ${JSON.stringify(back)}`);
	}

	// ── 2. The blob must not leak the plaintext ──────────────────────
	// It lands on a public, permanent chain. Decode to RAW BYTES first —
	// searching the base64 text is both flaky and blind (see the note above
	// the canaries).
	const raw = Buffer.from(blob, 'base64');
	const needles = [CANARY_FIAT, CANARY_HIDDEN, 'quietHours', 'preferences'];
	const leaked = needles.filter((n) => raw.includes(Buffer.from(n, 'utf8')));
	if (leaked.length === 0) {
		ok('the on-chain blob carries no plaintext settings values (checked on decoded bytes)');
	} else {
		bad(
			'confidentiality',
			`the encrypted blob contains plaintext ${leaked.map((l) => `"${l}"`).join(', ')} — settings would be world-readable, forever.`
		);
	}

	// ── 3. Wrong key → null, not a throw and not garbage ─────────────
	const wrong = await decryptSettingsState(key(99), 'kentest2', blob);
	if (wrong === null) {
		ok('a wrong/rotated key decrypts to null (caller falls back to device defaults)');
	} else {
		bad('wrong key', `expected null, got ${JSON.stringify(wrong)} — a wrong key must never yield state.`);
	}

	// ── 4. AAD binds the blob to the account ─────────────────────────
	// Without this, a blob could be replayed onto another account.
	const otherAccount = await decryptSettingsState(key(1), 'kentest3', blob);
	if (otherAccount === null) {
		ok("the blob is bound to its account (AAD) — it can't be replayed onto another account");
	} else {
		bad('aad', 'a blob decrypted under a DIFFERENT account name — the AAD binding is broken.');
	}

	// ── 5. Tampering is detected ─────────────────────────────────────
	const chars = blob.split('');
	const i = chars.length - 5;
	chars[i] = chars[i] === 'A' ? 'B' : 'A';
	const tampered = await decryptSettingsState(key(1), 'kentest2', chars.join(''));
	if (tampered === null) {
		ok('a tampered blob is rejected (Poly1305 tag) rather than partially trusted');
	} else {
		bad('tamper', 'a tampered ciphertext decrypted — the auth tag is not being enforced.');
	}

	// ── 6. Junk input degrades to null, never throws ─────────────────
	const junk = await decryptSettingsState(key(1), 'kentest2', 'not-base64-!!!');
	if (junk === null) {
		ok('malformed input returns null instead of throwing (settings page can still load)');
	} else {
		bad('robustness', 'malformed input did not return null.');
	}

	// ── 7. libsodium stays lazy at the source ────────────────────────
	const src = readFileSync(resolve(WEB, 'src/lib/settings/settingsCrypto.ts'), 'utf8');
	const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	if (/from '\$crypto\/sodium'/.test(code) && !/from 'libsodium-wrappers-sumo'/.test(code)) {
		ok('libsodium is imported lazily via $crypto/sodium (not statically)');
	} else {
		bad(
			'footprint',
			"settingsCrypto statically imports libsodium again. This module is reachable from the shared [lang] layout, so that puts ~1 MB of crypto into EVERY page's preload closure — including for visitors who never sign in (priority #4)."
		);
	}

	console.log('\n' + '─'.repeat(56));
	if (fail === 0) {
		console.log(`✓ all ${pass} scenarios passed`);
		process.exit(0);
	} else {
		console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
		process.exit(1);
	}
}

void main();
