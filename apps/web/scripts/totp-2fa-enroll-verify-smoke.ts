/**
 * Morphit — TOTP (2FA) enroll + verify + survives-password-change smoke.
 *
 * TOTP needs no device — the code is a pure function of the secret + the
 * clock — so the whole 2FA path is testable here: the RFC 6238 algorithm,
 * the keystore-level enroll + verify gate, the backup-code recovery path,
 * and (the claim the old REVISIT note got wrong) that TOTP SURVIVES a
 * password change.  totpSecret/backup codes live INSIDE the encrypted
 * identity blob, so re-encrypting under a new password — exactly what
 * changePassword does for a simple-passphrase (TOTP) keystore — preserves
 * them.
 *
 * Asserts:
 *   1. RFC 6238 round-trip: computeCode(secret, now) verifies via verifyCode.
 *   2. enrollTotp -> envelope decrypts to an identity carrying totpSecret.
 *   3. verifyTotpOrBackup accepts a freshly-computed code (kind 'ok').
 *   4. a wrong code is rejected (throws).
 *   5. SURVIVES PASSWORD CHANGE: decrypt-with-old -> re-encrypt-with-new
 *      (the changePassword path) -> the new envelope still verifies a TOTP code.
 *   6. a backup code redeems (kind 'backup_redeemed').
 */
import sodium from 'libsodium-wrappers-sumo';

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
const { generateSecret, computeCode, verifyCode } = await import('../src/lib/auth/totp.ts');
const { generatePlaintextCodes } = await import('../src/lib/auth/backupCodes.ts');
const { enrollTotp } = await import('../src/lib/crypto/keystoreTotpEnroll.ts');
const { verifyTotpOrBackup } = await import('../src/lib/crypto/keystoreTotp.ts');
const { encryptIdentity, decryptIdentity } = await import('../src/lib/crypto/keystore.ts');
const { generateFullIdentity } = await import('../src/lib/crypto/keygen.ts');

const now = Math.floor(Date.now() / 1000);

// 1. RFC 6238 algorithm round-trip.
const secret = generateSecret();
const code = await computeCode(secret, now);
const algoOk = await verifyCode(secret, code);
ok(/^\d{6}$/.test(code) && algoOk.valid === true, 'computeCode produces a 6-digit code that verifyCode accepts');

// 2-3. Enroll TOTP on a fresh identity, then verify through the keystore gate.
const OLD_PW = 'old-passphrase-1';
const NEW_PW = 'new-passphrase-2';
const backupCodes = generatePlaintextCodes();
const full = await generateFullIdentity();
const enrolled = await enrollTotp(full, OLD_PW, secret, backupCodes);
const id1 = await decryptIdentity(enrolled.envelope as never, OLD_PW);
ok(!!id1.totpSecret, 'enrolled envelope decrypts to an identity carrying totpSecret');

const gate1 = await verifyTotpOrBackup(id1, await computeCode(id1.totpSecret!, now));
ok(gate1.kind === 'ok', 'verifyTotpOrBackup accepts a freshly-computed code');

// 4. Wrong code rejected.
let wrongRejected = false;
try {
	// A code that is not valid for the current step (offset far outside the ±1 window).
	const wrong = await computeCode(id1.totpSecret!, now + 10_000);
	await verifyTotpOrBackup(id1, wrong);
	wrongRejected = false;
} catch {
	wrongRejected = true;
}
ok(wrongRejected, 'a wrong/out-of-window code is rejected');

// 5. SURVIVES a password change: mirror changePassword (decrypt old -> re-encrypt new).
const reDecrypted = await decryptIdentity(enrolled.envelope as never, OLD_PW);
const newEnv = await encryptIdentity(reDecrypted, NEW_PW);
const id2 = await decryptIdentity(newEnv as never, NEW_PW);
ok(!!id2.totpSecret, 'after a password change, totpSecret is still present');
const gate2 = await verifyTotpOrBackup(id2, await computeCode(id2.totpSecret!, now));
ok(gate2.kind === 'ok', 'after a password change, a TOTP code still verifies');

// 6. Backup code redemption.
const redeem = await verifyTotpOrBackup(id1, backupCodes[0]);
ok(redeem.kind === 'backup_redeemed', 'a backup code redeems');

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} totp-2fa-enroll-verify scenarios passed`);
