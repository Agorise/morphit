/**
 * i2p-destination-smoke.
 *
 * Locks down the I2P b32 address derivation (init/i2pDestination.ts):
 *   - a REAL i2pd 2.49 keyfile (captured as base64) pins the algorithm —
 *     base32(SHA-256(keyfile[0:391])) must reproduce the b32 that i2pd
 *     itself assigned to that destination (i2pd names its LeaseSet cache
 *     files `<b32>.<N>.dat`, which is where the expected value comes from,
 *     confirmed on two independent generations during development),
 *   - the derived address matches the `.b32.i2p` shape,
 *   - only the leading 391-byte Destination is hashed: mutating a byte in
 *     the trailing PRIVATE material leaves the address unchanged, while
 *     mutating a Destination byte changes it,
 *   - the signature-type-7 guard accepts the real keyfile and rejects a
 *     truncated / wrong-certificate buffer,
 *   - a too-short buffer throws rather than advertising a dead pointer.
 *
 * Unlike Tor, we cannot mint an I2P destination in Node (ElGamal keygen is
 * not available), so i2pd is the authoritative generator; this smoke pins
 * the READ side (deriving the advertised address from i2pd's keyfile).
 */

import {
	i2pB32FromKeyfile,
	isSigType7Keyfile,
	I2P_KEYS_AND_CERT_LEN,
	I2pKeyfileError
} from '../src/init/i2pDestination.ts';

let pass = 0;
let fail = 0;
function expect(name: string, cond: boolean, msg = ''): void {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}${msg ? ` — ${msg}` : ''}`);
	}
}

// ─── Real-i2pd test vector ───────────────────────────────────────────
// A 679-byte keyfile produced by `i2pd 2.49` (signature type 7 EdDSA-
// Ed25519, crypto type 0 ElGamal).  EXPECTED_B32 is the address i2pd
// assigned it (from its own `destinations/<b32>.4.dat` cache filename).
const VECTOR_KEYFILE_B64 =
	'qBFe7H79J64NibgwyomIYUwwLrLdGHKt5u7Ni8P5a4WoEV7sfv0nrg2JuDDKiYhhTDAust0Ycq3m7s2Lw/lrhagRXux+/SeuDYm4MMqJiGFMMC6y3RhyrebuzYvD+WuFqBFe7H79J64NibgwyomIYUwwLrLdGHKt5u7Ni8P5a4WoEV7sfv0nrg2JuDDKiYhhTDAust0Ycq3m7s2Lw/lrhagRXux+/SeuDYm4MMqJiGFMMC6y3RhyrebuzYvD+WuFqBFe7H79J64NibgwyomIYUwwLrLdGHKt5u7Ni8P5a4WoEV7sfv0nrg2JuDDKiYhhTDAust0Ycq3m7s2Lw/lrhagRXux+/SeuDYm4MMqJiGFMMC6y3RhyrebuzYvD+WuFqBFe7H79J64NibgwyomIYUwwLrLdGHKt5u7Ni8P5a4WoEV7sfv0nrg2JuDDKiYhhTDAust0Ycq3m7s2Lw/lrhWRh+1uXonmlPMOCrVYVyY5ozHsLLDz6PPvxJ3Jr7CT7BQAEAAcAAPVb/aLQE+ZvgmFz+id+z3CQuwcP0diVcl0Al72uYCmSdvMzmuR1Z0ttKf2qn5F35dHozJCKS+NWf1f1zLV2h2RaGJonj9qJMcTpeaDcmIekwPKSDNclupB9CG5mKQgjSfwg406mLpNZpGadfn+sGwXuvNjbmIfi+TV2QJfj/emdNZhPxBJR6GB7XF1CkqAA2yYvlIw80vdKJVp/ygq5rb6w/+iuq+nsmUQGsUStGXWPXvG/7H1u4UiMFsqNRwGRj6Zk3HkE+4FgD1oOWSQQ9kuiZY1xM538ByhYkUOtIbknsv5Qizh7YT2tdWoLCqNWeiQstJZlaiD8a3f2c9xu3XOqisU34YZMlf33GABgJq06WsRoy6Dd036sWZFSkG+yIA==';
const EXPECTED_B32 = 'xfff234g3gdbznln7ej55xri4k5sn7x5wx3xmbpqpwyi5ezboz7q.b32.i2p';

const keyfile = Buffer.from(VECTOR_KEYFILE_B64, 'base64');

expect('test-vector keyfile is 679 bytes', keyfile.length === 679, String(keyfile.length));
expect('KeysAndCert length constant is 391', I2P_KEYS_AND_CERT_LEN === 391);

{
	const b32 = i2pB32FromKeyfile(keyfile);
	expect('real i2pd keyfile derives the pinned b32', b32 === EXPECTED_B32, b32);
	expect('derived address matches the .b32.i2p shape', /^[a-z2-7]{52,}\.b32\.i2p$/.test(b32), b32);
}

// ─── sig-type-7 guard ────────────────────────────────────────────────
expect('real keyfile is recognised as signature-type-7', isSigType7Keyfile(keyfile));
expect('truncated buffer is not signature-type-7', !isSigType7Keyfile(keyfile.subarray(0, 200)));
{
	// corrupt the certificate type byte (offset 384) → must be rejected
	const bad = Buffer.from(keyfile);
	bad[384] = 0x03; // not a KeyCertificate
	expect('wrong certificate type is not signature-type-7', !isSigType7Keyfile(bad));
}
{
	// corrupt the sig-type field (offset 387-388) → 8 instead of 7
	const bad = Buffer.from(keyfile);
	bad[388] = 0x08;
	expect('non-Ed25519 sig type is not signature-type-7', !isSigType7Keyfile(bad));
}

// ─── only the Destination (first 391 bytes) is hashed ────────────────
{
	// mutate a PRIVATE-material byte (offset >= 391) → address unchanged
	const priv = Buffer.from(keyfile);
	priv[500] = priv[500]! ^ 0xff;
	expect('mutating private material does not change the address', i2pB32FromKeyfile(priv) === EXPECTED_B32);
}
{
	// mutate a DESTINATION byte (offset < 384, inside the key fields) →
	// address must change (and stays sig-type-7 since the cert is intact)
	const dest = Buffer.from(keyfile);
	dest[10] = dest[10]! ^ 0xff;
	expect('mutating the Destination changes the address', i2pB32FromKeyfile(dest) !== EXPECTED_B32);
}

// ─── rejects malformed input ─────────────────────────────────────────
{
	let threw = false;
	try {
		i2pB32FromKeyfile(Buffer.alloc(100));
	} catch (e) {
		threw = e instanceof I2pKeyfileError;
	}
	expect('too-short buffer throws I2pKeyfileError', threw);
}
{
	let threw = false;
	try {
		// long enough, but not a KeyCertificate at offset 384
		i2pB32FromKeyfile(Buffer.alloc(679));
	} catch (e) {
		threw = e instanceof I2pKeyfileError;
	}
	expect('wrong-format 679-byte buffer throws I2pKeyfileError', threw);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 i2p-destination smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} i2p-destination checks passed`);
