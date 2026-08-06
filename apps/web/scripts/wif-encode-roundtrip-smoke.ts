#!/usr/bin/env tsx
/**
 * Smoke: `rawPrivateKeyToWif` must produce byte-identical WIFs to
 * @beblurt/dblurt (the canonical Blurt implementation) and round-trip
 * through `wifToRawPrivateKey`.
 *
 * Why this matters: this encoder feeds the account-backup "your keys"
 * panel. If it drifts, we'd hand new users WIFs that no Blurt tool
 * (blurtwallet.com etc.) would accept — a silent, catastrophic loss of
 * account portability. dblurt is the gold standard; we assert equality.
 *
 * Tamper: change the version byte (0x80), drop the double-SHA256
 * checksum, or break base58Encode → fails the dblurt-equality assertion.
 */
import { PrivateKey } from '@beblurt/dblurt';
import { rawPrivateKeyToWif, wifToRawPrivateKey } from '../src/lib/crypto/wif.ts';

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

console.log('wif-encode-roundtrip smoke');
console.log('==========================');

const seeds = ['morphit-test-seed-42', 'another seed here', 'x', 'a quick brown fox jumps'];
for (const s of seeds) {
	const priv = PrivateKey.fromSeed(s);
	const dblurtWif = priv.toString();
	const scalar = new Uint8Array((priv as unknown as { key: Buffer }).key);
	const mine = await rawPrivateKeyToWif(scalar);
	check(`WIF == dblurt for "${s}"`, mine === dblurtWif, `mine=${mine} dblurt=${dblurtWif}`);
	check(`WIF is "5…" 51 chars for "${s}"`, mine.startsWith('5') && mine.length === 51, `len=${mine.length}`);
	const back = await wifToRawPrivateKey(mine);
	check(`encode→decode round-trips for "${s}"`, eq(back, scalar));
}

// Guard rails: malformed scalars must throw, not silently encode garbage.
let threwShort = false;
try {
	await rawPrivateKeyToWif(new Uint8Array(31));
} catch {
	threwShort = true;
}
check('rejects wrong-length scalar', threwShort);

console.log(failures === 0 ? `\n✓ all ${total} scenarios passed` : `\n✗ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
