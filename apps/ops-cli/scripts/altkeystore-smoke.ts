#!/usr/bin/env tsx
/**
 * Smoke for altKeystore — encrypted-at-rest alt-network service
 * keys.
 *
 * Coverage:
 *   - round-trip encrypt → decrypt under correct passphrase
 *   - decrypt fails under wrong passphrase
 *   - decrypt fails when AAD network is swapped (cross-network
 *     swap defense)
 *   - decrypt fails on tampered ciphertext
 *   - reject too-short passphrases
 *   - reject empty plaintext
 *   - works for all three networks
 *   - envelope is JSON-roundtrippable
 *   - distinct envelopes for the same plaintext + passphrase
 *     (because of fresh salt + IV)
 */

import {
	encryptAltKey,
	decryptAltKey,
	altKeystoreFilename,
	type AltKeyEnvelope,
	type AltNetwork
} from '../src/init/altKeystore.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqualBytes(a: Buffer, b: Buffer, label: string): void {
	if (a.length !== b.length) {
		throw new Error(`${label}: lengths differ (${a.length} vs ${b.length})`);
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			throw new Error(`${label}: byte ${i} differs`);
		}
	}
}

function assertThrows(fn: () => void, label: string, msgFragment?: string): void {
	let threw = false;
	let caught: unknown;
	try {
		fn();
	} catch (err) {
		threw = true;
		caught = err;
	}
	if (!threw) {
		throw new Error(`${label}: expected to throw, did not`);
	}
	if (msgFragment !== undefined) {
		const msg = caught instanceof Error ? caught.message : String(caught);
		if (!msg.toLowerCase().includes(msgFragment.toLowerCase())) {
			throw new Error(
				`${label}: error message did not contain ${JSON.stringify(msgFragment)}: ${msg}`
			);
		}
	}
}

console.log('\n── altKeystore smoke ────────────────────────────────────\n');

// 96-byte synthetic Tor v3-style key (right size for that
// network's hint check; content is dummy).
const torKey = Buffer.from(new Uint8Array(96).map((_, i) => (i * 7 + 13) % 256));

const passphrase = 'correct-horse-battery-staple';

scenario('round-trip: tor key encrypt → decrypt', () => {
	const env = encryptAltKey(torKey, passphrase, 'tor');
	const decrypted = decryptAltKey(env, passphrase);
	assertEqualBytes(decrypted, torKey, 'plaintext');
});

scenario('round-trip: lokinet key encrypt → decrypt', () => {
	const lokiKey = Buffer.from('synthetic-lokinet-key-bytes');
	const env = encryptAltKey(lokiKey, passphrase, 'lokinet');
	const decrypted = decryptAltKey(env, passphrase);
	assertEqualBytes(decrypted, lokiKey, 'plaintext');
});

scenario('round-trip: i2p key encrypt → decrypt', () => {
	const i2pKey = Buffer.from('synthetic-i2p-eepsite-bytes');
	const env = encryptAltKey(i2pKey, passphrase, 'i2p');
	const decrypted = decryptAltKey(env, passphrase);
	assertEqualBytes(decrypted, i2pKey, 'plaintext');
});

scenario('wrong passphrase fails', () => {
	const env = encryptAltKey(torKey, passphrase, 'tor');
	assertThrows(
		() => decryptAltKey(env, 'wrong-passphrase'),
		'wrong passphrase',
		'decryption failed'
	);
});

scenario('short passphrase rejected at encrypt', () => {
	assertThrows(() => encryptAltKey(torKey, '1234567', 'tor'), 'short passphrase', '8 characters');
});

scenario('empty plaintext rejected', () => {
	assertThrows(() => encryptAltKey(Buffer.alloc(0), passphrase, 'tor'), 'empty plaintext', 'empty');
});

scenario('cross-network swap defense: tor envelope claiming lokinet fails', () => {
	const env = encryptAltKey(torKey, passphrase, 'tor');
	const swapped: AltKeyEnvelope = { ...env, network: 'lokinet' };
	assertThrows(() => decryptAltKey(swapped, passphrase), 'swapped network', 'decryption failed');
});

scenario('tampered ciphertext fails', () => {
	const env = encryptAltKey(torKey, passphrase, 'tor');
	// Flip one byte in the ciphertext.
	const ctBytes = Buffer.from(env.ct, 'base64');
	ctBytes[0] = ctBytes[0]! ^ 0x01;
	const tampered: AltKeyEnvelope = { ...env, ct: ctBytes.toString('base64') };
	assertThrows(() => decryptAltKey(tampered, passphrase), 'tampered ct', 'decryption failed');
});

scenario('tampered IV fails', () => {
	const env = encryptAltKey(torKey, passphrase, 'tor');
	const ivBytes = Buffer.from(env.iv, 'base64');
	ivBytes[0] = ivBytes[0]! ^ 0xff;
	const tampered: AltKeyEnvelope = { ...env, iv: ivBytes.toString('base64') };
	assertThrows(() => decryptAltKey(tampered, passphrase), 'tampered iv', 'decryption failed');
});

scenario('JSON-roundtrip preserves decryptability', () => {
	const env = encryptAltKey(torKey, passphrase, 'tor');
	const json = JSON.stringify(env);
	const parsed = JSON.parse(json) as AltKeyEnvelope;
	const decrypted = decryptAltKey(parsed, passphrase);
	assertEqualBytes(decrypted, torKey, 'plaintext');
});

scenario('two encryptions of same input produce different ciphertexts', () => {
	const a = encryptAltKey(torKey, passphrase, 'tor');
	const b = encryptAltKey(torKey, passphrase, 'tor');
	if (a.iv === b.iv) {
		throw new Error('IVs collided — randomness broken');
	}
	if (a.kdf_params.salt === b.kdf_params.salt) {
		throw new Error('salts collided — randomness broken');
	}
	if (a.ct === b.ct) {
		throw new Error('ciphertexts identical — encryption broken');
	}
	// But both still decrypt to the same plaintext.
	assertEqualBytes(decryptAltKey(a, passphrase), torKey, 'a');
	assertEqualBytes(decryptAltKey(b, passphrase), torKey, 'b');
});

scenario('envelope rejects unknown version on decrypt', () => {
	const env = encryptAltKey(torKey, passphrase, 'tor');
	const bumped = { ...env, v: 99 } as unknown as AltKeyEnvelope;
	assertThrows(
		() => decryptAltKey(bumped, passphrase),
		'bumped version',
		'unsupported envelope version'
	);
});

scenario('envelope rejects wrong purpose on decrypt', () => {
	const env = encryptAltKey(torKey, passphrase, 'tor');
	const wrongPurpose = {
		...env,
		purpose: 'morphit-relay-key' as const
	} as unknown as AltKeyEnvelope;
	assertThrows(() => decryptAltKey(wrongPurpose, passphrase), 'wrong purpose', 'wrong purpose');
});

scenario('filenames are stable + distinct per network', () => {
	const a = altKeystoreFilename('tor');
	const b = altKeystoreFilename('lokinet');
	const c = altKeystoreFilename('i2p');
	if (a === b || b === c || a === c) {
		throw new Error('filename collision');
	}
	if (a !== 'tor-key.json') throw new Error(`expected tor-key.json, got ${a}`);
	if (b !== 'lokinet-key.json') throw new Error(`expected lokinet-key.json, got ${b}`);
	if (c !== 'i2p-key.json') throw new Error(`expected i2p-key.json, got ${c}`);
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
