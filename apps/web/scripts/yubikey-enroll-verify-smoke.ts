/**
 * Morphit — YubiKey enroll-time fail-closed verification smoke (cp331).
 *
 * Enrollment now PROVES the device performs real HMAC-SHA1 challenge-
 * response before committing a wrap (buildVerifiedYubikeyWrap /
 * verifyYubikeyChallengeResponse).  This guards the WebHID transport's
 * most likely failure mode — challenge-INDEPENDENT output (see the
 * diagnosis in transport.ts) — which a naive single-tap enroll would
 * have silently committed as a CONSTANT / zero-entropy "2FA factor", a
 * factor unlockable by a known constant (security theatre).
 *
 * To this layer a YubiKey is just a `YubikeyHmacFn`
 * ((challenge:Uint8Array[64]) => Promise<Uint8Array[20]>), so simulated
 * stubs exercise the entire gate without a physical device.
 *
 * Asserts:
 *   1. A correct deterministic HMAC-SHA1 stub PASSES verify (yubikey wrap).
 *   2. verify taps the device exactly twice.
 *   3. The wrap built via verify round-trips (recoverCekFromYubikey
 *      recovers the exact CEK).
 *   4. A CONSTANT-output stub is REJECTED by buildVerifiedYubikeyWrap...
 *   5. ...and classifies as `enroll_verify_failed`.
 *   6. The reject path still taps exactly twice (both challenges sent).
 *   7. The legacy single-tap buildYubikeyWrap WOULD have accepted the
 *      constant stub — demonstrating exactly the hole the gate closes.
 *   8. An all-zero-bytes stub is REJECTED...
 *   9. ...and classifies as `enroll_verify_failed`.
 *  10. A wrong-length stub is REJECTED...
 *  11. ...and classifies as `protocol_violation`.
 *  12. A throwing/dead stub propagates its error (no silent success)...
 *  13. ...and classifies to its transport kind (`no_device`).
 *  14. enrollYubikey END-TO-END rejects a constant device (the gate is
 *      wired into enrollment, not merely available as a helper)...
 *  15. ...and that rejection classifies as `enroll_verify_failed`.
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
const { buildVerifiedYubikeyWrap, buildYubikeyWrap, verifyYubikeyChallengeResponse, recoverCekFromYubikey } =
	await import('../src/lib/crypto/yubikey/wrap.ts');
const { generateCek, encryptIdentity } = await import('../src/lib/crypto/keystore.ts');
const { generateFullIdentity } = await import('../src/lib/crypto/keygen.ts');
const { enrollYubikey } = await import('../src/lib/crypto/keystoreYubikey.ts');
const { classifyYubikeyError } = await import('../src/lib/crypto/yubikeyErrors.ts');

const SLOT = 2 as 1 | 2;

/** Wrap an inner HMAC function with a tap counter. */
function countingStub(inner: (c: Uint8Array) => Uint8Array) {
	let taps = 0;
	const fn = async (challenge: Uint8Array): Promise<Uint8Array> => {
		taps++;
		return inner(challenge);
	};
	return { fn, taps: () => taps };
}

// A correct simulated slot: deterministic HMAC-SHA1(secret, challenge).
function realInner(secretHex: string): (c: Uint8Array) => Uint8Array {
	const secret = Buffer.from(secretHex, 'hex');
	return (challenge: Uint8Array) =>
		new Uint8Array(createHmac('sha1', secret).update(Buffer.from(challenge)).digest());
}

async function freshCek(): Promise<Uint8Array> {
	return generateCek();
}

// ── 1-3. Correct stub: passes, two taps, round-trips ──────────────────
{
	const real = countingStub(realInner('00112233445566778899aabbccddeeff00112233'));
	const cek = await freshCek();
	const wrap = await buildVerifiedYubikeyWrap(cek, real.fn, SLOT, 'Test Key');
	ok(wrap.kind === 'yubikey', 'correct stub: buildVerifiedYubikeyWrap returns a yubikey wrap');
	ok(real.taps() === 2, 'correct stub: verify taps the device exactly twice');
	// recoverCekFromYubikey re-derives via the stored challenge; the
	// deterministic stub reproduces the response, so the CEK comes back.
	const recovered = await recoverCekFromYubikey(wrap, real.fn);
	ok(
		recovered.length === cek.length && sodium.memcmp(recovered, cek),
		'correct stub: wrap built via verify round-trips (exact CEK recovered)'
	);
	sodium.memzero(recovered);
	sodium.memzero(cek);
}

// ── 4-7. Constant-output stub: rejected (theatre), legacy would accept ─
{
	const constReject = countingStub(() => new Uint8Array(20).fill(0xab));
	let rejected = false;
	let kind: string | null = null;
	try {
		await buildVerifiedYubikeyWrap(await freshCek(), constReject.fn, SLOT, '');
	} catch (e) {
		rejected = true;
		kind = classifyYubikeyError(e);
	}
	ok(rejected, 'constant-output stub: rejected by buildVerifiedYubikeyWrap');
	ok(kind === 'enroll_verify_failed', 'constant-output stub: classifies as enroll_verify_failed');
	ok(constReject.taps() === 2, 'constant-output stub: reject path still taps exactly twice');

	// Demonstrate the gap the gate closes: the bare single-tap primitive
	// commits a wrap around the constant without complaint.
	const legacyConst = countingStub(() => new Uint8Array(20).fill(0xab));
	const legacyWrap = await buildYubikeyWrap(await freshCek(), legacyConst.fn, SLOT, '');
	ok(
		legacyWrap.kind === 'yubikey' && legacyConst.taps() === 1,
		'legacy single-tap buildYubikeyWrap WOULD have accepted the constant stub (the closed gap)'
	);
}

// ── 8-9. All-zero stub: rejected ──────────────────────────────────────
{
	const zero = countingStub(() => new Uint8Array(20)); // 20 zero bytes
	let rejected = false;
	let kind: string | null = null;
	try {
		await buildVerifiedYubikeyWrap(await freshCek(), zero.fn, SLOT, '');
	} catch (e) {
		rejected = true;
		kind = classifyYubikeyError(e);
	}
	ok(rejected, 'zero-output stub: rejected by buildVerifiedYubikeyWrap');
	ok(kind === 'enroll_verify_failed', 'zero-output stub: classifies as enroll_verify_failed');
}

// ── 10-11. Wrong-length stub: rejected as protocol_violation ──────────
{
	const short = countingStub(() => new Uint8Array(16)); // not 20
	let rejected = false;
	let kind: string | null = null;
	try {
		await verifyYubikeyChallengeResponse(short.fn);
	} catch (e) {
		rejected = true;
		kind = classifyYubikeyError(e);
	}
	ok(rejected, 'wrong-length stub: rejected by verify');
	ok(kind === 'protocol_violation', 'wrong-length stub: classifies as protocol_violation');
}

// ── 12-13. Throwing/dead stub: propagates (never silently succeeds) ───
{
	const dead = countingStub(() => {
		throw new Error('no-device-selected');
	});
	let rejected = false;
	let kind: string | null = null;
	try {
		await buildVerifiedYubikeyWrap(await freshCek(), dead.fn, SLOT, '');
	} catch (e) {
		rejected = true;
		kind = classifyYubikeyError(e);
	}
	ok(rejected, 'dead stub: error propagates (no silent success)');
	ok(kind === 'no_device', 'dead stub: classifies to its transport kind (no_device)');
}

// ── 14-15. enrollYubikey END-TO-END rejects a constant device ─────────
{
	const PW = 'passphrase-1234';
	const full = await generateFullIdentity();
	const simpleEnv = await encryptIdentity(full, PW);
	const constEnroll = countingStub(() => new Uint8Array(20).fill(0x7c));
	let rejected = false;
	let kind: string | null = null;
	try {
		await enrollYubikey(simpleEnv as never, PW, constEnroll.fn, SLOT, 'X');
	} catch (e) {
		rejected = true;
		kind = classifyYubikeyError(e);
	}
	ok(rejected, 'enrollYubikey end-to-end: rejects a constant-output device (gate is wired into enrollment)');
	ok(kind === 'enroll_verify_failed', 'enrollYubikey end-to-end: classifies as enroll_verify_failed');
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} yubikey-enroll-verify scenarios passed`);
