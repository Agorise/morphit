/**
 * tor-onion-smoke.
 *
 * Locks down the basic v3 onion generator (init/torOnion.ts):
 *   - a FIXED-SEED test vector (cross-checked against PyNaCl + Python
 *     stdlib base32 during development) pins the address algorithm,
 *   - base32 round-trips,
 *   - decodeOnionAddress validates checksum + version and recovers the
 *     pubkey (and rejects a tampered address),
 *   - generateOnionV3 emits a well-formed address + the three Tor HS
 *     files in Tor's exact byte layout (96-byte secret, 64-byte public,
 *     correct ASCII headers, hostname = address + newline),
 *   - two generations differ (real randomness).
 *
 * The address algorithm is Tor rend-spec-v3 §6; whether the Tor daemon
 * actually serves it is a host concern (no Tor in-sandbox), covered by
 * the tor Ansible role's syntax/lint + the operator's deploy.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
	base32Encode,
	base32Decode,
	onionAddressFromPubkey,
	decodeOnionAddress,
	generateOnionV3
} from '../src/init/torOnion.ts';

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

// ─── Fixed-seed test vector ──────────────────────────────────────────
// seed = 0x42 × 32  →  (validated independently with PyNaCl + base64.b32encode)
const VECTOR_SEED_HEX = '42'.repeat(32);
const VECTOR_PUBKEY_HEX = '2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12';
const VECTOR_ADDRESS = 'efjprum3peosirjsilqv6lvlns3476t3njpngaexsyhangeb3mjo7sad.onion';

// Build a public key from the known seed via PKCS8, to confirm Node derives
// the same pubkey we pinned (and thus the same address).
function pubkeyFromSeed(seedHex: string): Buffer {
	const pkcs8 = Buffer.concat([
		Buffer.from('302e020100300506032b657004220420', 'hex'),
		Buffer.from(seedHex, 'hex')
	]);
	const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
	const pub = createPublicKey(priv);
	const jwk = pub.export({ format: 'jwk' }) as { x?: string };
	return Buffer.from(jwk.x ?? '', 'base64url');
}

{
	const pub = pubkeyFromSeed(VECTOR_SEED_HEX);
	expect('fixed seed derives the pinned pubkey', pub.toString('hex') === VECTOR_PUBKEY_HEX, pub.toString('hex'));
	const addr = onionAddressFromPubkey(pub);
	expect('fixed pubkey derives the pinned v3 address', addr === VECTOR_ADDRESS, addr);
	expect('vector address matches the v3 onion shape', /^[a-z2-7]{56}\.onion$/.test(VECTOR_ADDRESS));
}

// onionAddressFromPubkey rejects a wrong-length key
{
	let threw = false;
	try {
		onionAddressFromPubkey(Buffer.alloc(31));
	} catch {
		threw = true;
	}
	expect('onionAddressFromPubkey rejects a non-32-byte key', threw);
}

// ─── base32 round-trips ──────────────────────────────────────────────
{
	let ok = true;
	for (let i = 0; i < 50; i++) {
		const len = 1 + (i % 40);
		const buf = Buffer.alloc(len);
		for (let j = 0; j < len; j++) buf[j] = (i * 7 + j * 13) & 0xff;
		// pad to a 5-byte boundary so encode/decode is lossless
		const padded = Buffer.concat([buf, Buffer.alloc((5 - (len % 5)) % 5)]);
		if (!base32Decode(base32Encode(padded)).equals(padded)) {
			ok = false;
			break;
		}
	}
	expect('base32 encode/decode round-trips', ok);
}

// ─── decode validates + recovers pubkey ──────────────────────────────
{
	const dec = decodeOnionAddress(VECTOR_ADDRESS);
	expect('decode recovers the pinned pubkey', dec.pubkey.toString('hex') === VECTOR_PUBKEY_HEX);
	expect('decode reports a valid checksum', dec.checksumOk);
	expect('decode reports version 3', dec.version === 3);
}

// tamper: flip the first address char → checksum must fail
{
	const first = VECTOR_ADDRESS[0];
	const swapped = (first === 'a' ? 'b' : 'a') + VECTOR_ADDRESS.slice(1);
	const dec = decodeOnionAddress(swapped);
	expect('tampered address fails the checksum', !dec.checksumOk);
}

// ─── generateOnionV3: address + the three Tor HS files ───────────────
const SECRET_HEADER = (() => {
	const b = Buffer.alloc(32, 0);
	Buffer.from('== ed25519v1-secret: type0 ==', 'ascii').copy(b);
	return b;
})();
const PUBLIC_HEADER = (() => {
	const b = Buffer.alloc(32, 0);
	Buffer.from('== ed25519v1-public: type0 ==', 'ascii').copy(b);
	return b;
})();

{
	const o = generateOnionV3();
	expect('generated address matches the v3 shape', /^[a-z2-7]{56}\.onion$/.test(o.address), o.address);
	const dec = decodeOnionAddress(o.address);
	expect('generated address decodes to its own pubkey', dec.pubkey.equals(o.publicKey));
	expect('generated address checksum is valid', dec.checksumOk);

	expect('hs_ed25519_secret_key is 96 bytes', o.secretKeyFile.length === 96, String(o.secretKeyFile.length));
	expect('secret-key header is Tor ed25519v1-secret', o.secretKeyFile.subarray(0, 32).equals(SECRET_HEADER));

	expect('hs_ed25519_public_key is 64 bytes', o.publicKeyFile.length === 64, String(o.publicKeyFile.length));
	expect('public-key header is Tor ed25519v1-public', o.publicKeyFile.subarray(0, 32).equals(PUBLIC_HEADER));
	expect('public-key file embeds the pubkey', o.publicKeyFile.subarray(32).equals(o.publicKey));

	expect('hostname file is address + newline', o.hostnameFile === o.address + '\n');
}

// randomness: two generations differ
{
	const a = generateOnionV3();
	const b = generateOnionV3();
	expect('two generations produce different addresses', a.address !== b.address);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 tor-onion smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} tor-onion checks passed`);
