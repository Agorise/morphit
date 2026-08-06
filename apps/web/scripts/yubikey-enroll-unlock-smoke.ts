/**
 * Morphit — YubiKey enroll + unlock round-trip smoke (simulated device).
 *
 * To this code a YubiKey is just a `YubikeyHmacFn`:
 *     (challenge: Uint8Array[64]) => Promise<Uint8Array[20]>   // HMAC-SHA1(slot_secret, challenge)
 * so a deterministic HMAC-SHA1 with a fixed secret exercises the ENTIRE
 * enroll + unwrap path — challenge generation + storage, the Argon2id-over-
 * HMAC wrap-key derivation, and the crypto_secretbox wrap/unwrap — everything
 * except the physical device's touch + HMAC.  This is the FIRST automated
 * coverage of that path.  Before the CEK_NONCE_BYTES 12->24 fix, every step
 * here threw "invalid nonce length" inside crypto_secretbox_easy, so YubiKey
 * enrollment was completely non-functional at runtime.
 *
 * Asserts:
 *   1. enrollYubikey on a simple-passphrase env -> a layered-cek envelope.
 *   2. the result has BOTH a yubikey wrap and the original passphrase wrap.
 *   3. unlockWithYubikey (same simulated key) recovers an identity.
 *   4. the recovered identity matches the original (every role's public key).
 *   5. a DIFFERENT simulated key is rejected.
 *   6. the passphrase ALSO still unlocks the layered envelope.
 */
import sodium from 'libsodium-wrappers-sumo';
import { createHmac } from 'node:crypto';

let passes = 0;
let failures = 0;
function ok(cond: boolean, msg: string): void {
	if (cond) {
		passes++;
		console.log(`  ✓ ${msg}`);
	} else {
		failures++;
		console.log(`  ✗ ${msg}`);
	}
}

await sodium.ready;
// Dynamic import AFTER sodium.ready (keystore byte-length consts read libsodium at module-eval).
const { generateFullIdentity } = await import('../src/lib/crypto/keygen.ts');
const { encryptIdentity, decryptIdentity } = await import('../src/lib/crypto/keystore.ts');
const { enrollYubikey, unlockWithYubikey } = await import('../src/lib/crypto/keystoreYubikey.ts');

const ROLES = ['owner', 'active', 'posting', 'memo'] as const;
function fp(id: { keys: Record<string, { publicKey: Uint8Array } | null> }): string {
	return ROLES.map((r) => (id.keys[r] ? sodium.to_hex(id.keys[r]!.publicKey) : 'null')).join('|');
}

// A simulated YubiKey slot: deterministic HMAC-SHA1(secret, challenge) -> 20 bytes.
function makeYubiKey(secretHex: string) {
	const secret = Buffer.from(secretHex, 'hex');
	return async (challenge: Uint8Array): Promise<Uint8Array> =>
		new Uint8Array(createHmac('sha1', secret).update(Buffer.from(challenge)).digest());
}
const yubikey = makeYubiKey('00112233445566778899aabbccddeeff00112233');
const wrongYubikey = makeYubiKey('ffffffffffffffffffffffffffffffffffffffff');

const PW = 'passphrase-1234';
const full = await generateFullIdentity();
const baselineFp = fp(full as never);
const simpleEnv = await encryptIdentity(full, PW);

// 1-2. Enroll a YubiKey onto the simple-passphrase keystore.
const layered = await enrollYubikey(simpleEnv as never, PW, yubikey, 2 as never, 'Test Key');
ok(layered.scheme === 'layered-cek', 'enrollYubikey produces a layered-cek envelope');
ok(
	layered.wraps.some((w) => w.kind === 'yubikey'),
	'envelope has a yubikey wrap'
);
ok(
	layered.wraps.some((w) => w.kind === 'passphrase'),
	'envelope retains the passphrase wrap'
);

// 3-4. Unlock with the SAME simulated YubiKey.
const viaYk = await unlockWithYubikey(layered, yubikey);
ok(!!viaYk, 'unlockWithYubikey recovers an identity');
ok(fp(viaYk as never) === baselineFp, 'YubiKey-recovered identity matches the original (all roles)');

// 5. A different YubiKey must be rejected.
let wrongFailed = false;
try {
	await unlockWithYubikey(layered, wrongYubikey);
	wrongFailed = false;
} catch {
	wrongFailed = true;
}
ok(wrongFailed, 'a different YubiKey is rejected');

// 6. The passphrase still unlocks the layered envelope.
const viaPw = await decryptIdentity(layered as never, PW);
ok(fp(viaPw as never) === baselineFp, 'passphrase still unlocks the layered (YubiKey) envelope');

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} yubikey-enroll-unlock scenarios passed`);
