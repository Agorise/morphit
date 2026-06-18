#!/usr/bin/env tsx
/**
 * Smoke: `deriveBackupKeys` powers the account-backup "your keys" panel.
 * For a full (morphit-seed) identity it must return all four roles in
 * owner→active→posting→memo order with BLT public keys and round-trippable
 * WIF private keys; for a posting-only identity it must return ONLY the
 * posting key (the other three slots are null and must be skipped).
 *
 * Tamper: include null roles, reorder, or hand back a bad WIF → fails.
 */
import { generateFullIdentity, importPostingOnlyIdentity } from '../src/lib/crypto/keygen.ts';
import { deriveBackupKeys } from '../src/lib/crypto/keyExport.ts';
import { wifToRawPrivateKey } from '../src/lib/crypto/wif.ts';

let failures = 0;
let total = 0;
function check(label: string, ok: boolean, detail = ''): void {
	total++;
	if (ok) console.log(`  ✓ ${label}`);
	else {
		console.error(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`);
		failures++;
	}
}
function eq(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

console.log('key-backup-derivation smoke');
console.log('===========================');

// Full identity → all four keys.
const full = await generateFullIdentity();
const keys = await deriveBackupKeys(full);
check('four keys returned', keys.length === 4, `got ${keys.length}`);
check(
	'order owner→active→posting→memo',
	keys.map((k) => k.role).join(',') === 'owner,active,posting,memo',
	keys.map((k) => k.role).join(',')
);
for (const k of keys) {
	check(`${k.role}: BLT public key`, k.pub.startsWith('BLT'), k.pub);
	check(`${k.role}: WIF "5…" 51 chars`, k.wif.startsWith('5') && k.wif.length === 51, `len=${k.wif.length}`);
	const scalar = await wifToRawPrivateKey(k.wif);
	const fullKp = full.keys[k.role];
	check(`${k.role}: WIF decodes to the keypair's private scalar`, !!fullKp && eq(scalar, fullKp.privateKey));
}

// Posting-only identity → only the posting key.
const postingScalar = await wifToRawPrivateKey(keys[2]!.wif); // reuse a valid scalar
const { full: poFull } = await importPostingOnlyIdentity(postingScalar);
const poKeys = await deriveBackupKeys(poFull);
check('posting-only → exactly one key', poKeys.length === 1, `got ${poKeys.length}`);
check('posting-only → that key is posting', poKeys[0]?.role === 'posting', poKeys[0]?.role ?? 'none');

console.log(failures === 0 ? `\n✓ all ${total} scenarios passed` : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
