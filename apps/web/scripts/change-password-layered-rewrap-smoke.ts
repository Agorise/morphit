/**
 * Morphit — changePassword layered-cek wrap-preservation smoke (#11a).
 *
 * Regression net for the fix that stops a password change from silently
 * downgrading a YubiKey-protected keystore.  A `layered-cek` envelope
 * encrypts the identity to a random CEK and recovers that CEK through
 * independent `wraps[]` (a passphrase wrap + one or more yubikey wraps).
 * Changing the password must rotate ONLY the passphrase wrap.  Pre-fix,
 * `changePassword` re-encrypted via `encryptIdentity()` → a
 * `simple-passphrase` envelope, which has no `wraps[]` at all, so the
 * user's YubiKey unlock path was silently dropped.
 *
 * `rewrapLayeredPassphrase` recovers the CEK via the old password,
 * rebuilds the passphrase wrap from the new password, and carries every
 * non-passphrase wrap (yubikey) over verbatim — so both the yubikey wrap
 * bytes and the CEK/ciphertext are unchanged, and the YubiKey unlock path
 * is provably unaffected.  TOTP 2FA lives inside the identity ciphertext
 * (preserved byte-for-byte), so it survives regardless of scheme.
 *
 * Asserts:
 *   1. scheme stays 'layered-cek'.
 *   2. the yubikey wrap is byte-identical after the rewrap.
 *   3. the passphrase wrap is rotated (fresh salt + ciphertext).
 *   4. exactly one passphrase wrap remains (validateLayeredEnvelope invariant).
 *   5. cekNonce + ciphertext preserved byte-for-byte (identity + totpSecret).
 *   6. the rewrapped envelope decrypts with the NEW password.
 *   7. the rewrapped envelope rejects the OLD password.
 *   8. SOURCE GUARD: changePassword.ts branches on 'layered-cek' and calls
 *      rewrapLayeredPassphrase (not a bare encryptIdentity for layered).
 */
import sodium from 'libsodium-wrappers-sumo';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// Dynamic import AFTER sodium.ready: keystore's byte-length constants
// (CEK_NONCE_BYTES, etc.) are read from libsodium at module-eval time, so
// the module must not evaluate until libsodium is initialised.
const { generateFullIdentity } = await import('../src/lib/crypto/keygen.ts');
const { generateCek, encryptIdentityToCek, buildPassphraseWrap, decryptIdentity, rewrapLayeredPassphrase } =
	await import('../src/lib/crypto/keystore.ts');

const B64 = sodium.base64_variants.ORIGINAL;

const OLD_PW = 'old-password-1234';
const NEW_PW = 'new-password-5678';

// ── Build a layered-cek envelope: passphrase wrap + synthetic yubikey wrap ──
const full = await generateFullIdentity();
const cek = await generateCek();
const { cekNonce, ciphertext } = await encryptIdentityToCek(full, cek);
const ppWrap = await buildPassphraseWrap(cek, OLD_PW);

// Synthetic yubikey wrap — structurally valid (must satisfy
// validateLayeredEnvelope) so we can prove it is carried over verbatim.
// We never unwrap it; only its preservation matters here.
const ykNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
const ykKey = sodium.randombytes_buf(32);
const ykCt = sodium.crypto_secretbox_easy(cek, ykNonce, ykKey);
sodium.memzero(ykKey);
const yubikeyWrap = {
	kind: 'yubikey',
	schemaVersion: 1,
	slot: 1,
	challenge: sodium.to_base64(sodium.randombytes_buf(16), B64),
	label: 'test-key',
	kdf: 'argon2id',
	kdfParams: {
		opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
		memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
	},
	salt: sodium.to_base64(sodium.randombytes_buf(16), B64),
	nonce: sodium.to_base64(ykNonce, B64),
	ciphertext: sodium.to_base64(ykCt, B64)
};

const env = {
	scheme: 'layered-cek' as const,
	v: 1 as const,
	cekNonce: sodium.to_base64(cekNonce, B64),
	ciphertext: sodium.to_base64(ciphertext, B64),
	wraps: [ppWrap, yubikeyWrap],
	createdAt: Date.now()
};
sodium.memzero(cek);

// ── Rotate the passphrase ──
const rewrapped = await rewrapLayeredPassphrase(env as never, OLD_PW, NEW_PW);

ok(rewrapped.scheme === 'layered-cek', 'scheme stays layered-cek');

const newYk = rewrapped.wraps.find((w) => w.kind === 'yubikey');
ok(
	JSON.stringify(newYk) === JSON.stringify(yubikeyWrap),
	'yubikey wrap preserved byte-identical'
);

const newPp = rewrapped.wraps.find((w) => w.kind === 'passphrase') as
	| { salt: string; ciphertext: string }
	| undefined;
ok(
	!!newPp && newPp.salt !== ppWrap.salt && newPp.ciphertext !== ppWrap.ciphertext,
	'passphrase wrap rotated (fresh salt + ciphertext)'
);
ok(
	rewrapped.wraps.filter((w) => w.kind === 'passphrase').length === 1,
	'exactly one passphrase wrap remains'
);
ok(
	rewrapped.cekNonce === env.cekNonce && rewrapped.ciphertext === env.ciphertext,
	'identity ciphertext (incl. any totpSecret) preserved byte-for-byte'
);

let decNew = false;
try {
	await decryptIdentity(rewrapped as never, NEW_PW);
	decNew = true;
} catch {
	decNew = false;
}
ok(decNew, 'rewrapped envelope decrypts with the NEW password');

let decOld = false;
try {
	await decryptIdentity(rewrapped as never, OLD_PW);
	decOld = true;
} catch {
	decOld = false;
}
ok(!decOld, 'rewrapped envelope rejects the OLD password');

// ── Source guard: changePassword must use the rewrap for layered envelopes ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const cpSrc = readFileSync(join(__dirname, '../src/lib/crypto/changePassword.ts'), 'utf-8');
ok(
	/scheme === 'layered-cek'/.test(cpSrc) && /rewrapLayeredPassphrase\(/.test(cpSrc),
	'changePassword.ts branches on layered-cek and calls rewrapLayeredPassphrase'
);

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} change-password-layered-rewrap scenarios passed`);
