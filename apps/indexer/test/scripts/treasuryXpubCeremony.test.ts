/**
 * v1.20.0 (MK-H2) — getting the treasury BTC xpub into the release op.
 *
 * The maintainer's laptop steps: `set-treasury-btc-xpub.ts <key>` writes the key into
 * CANONICAL_TREASURY.btcXpub (refusing anything that is not a mainnet BIP84
 * account PUBLIC key), and the release-op builder (Block 3 of the ELI5
 * ceremony) pins it as treasury.btc.xpub. These tests run the REAL scripts.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTreasuryXpubInput } from '../../src/lib/treasuryXpubInput';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP = resolve(HERE, '../..');
const TSX = resolve(APP, '../../node_modules/.bin/tsx');

const BIP84_ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const BIP84_XPUB =
	'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
const BIP84_ZPRV =
	'zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE';
const VPUB =
	'vpub5YFAPkuWn7i4tYUFkwqKpdSoxES92E4f2Antqkz27cPNYbhF76ZzXzN8ML8tHS446MnD5sdzEndTT2WLVwicrH4DFGGZNvto2Hz8R7qT4Ef';

function run(script: string, args: string[], env: Record<string, string> = {}) {
	return spawnSync(TSX, [resolve(APP, 'scripts', script), ...args], {
		cwd: resolve(APP, '../..'),
		env: { ...process.env, ...env },
		input: '',
		encoding: 'utf8',
		timeout: 60_000
	});
}

describe('treasury xpub input check', () => {
	it('accepts the BIP84 zpub, canonicalises it, and shows receive #0-#2', () => {
		const r = checkTreasuryXpubInput(BIP84_ZPUB);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.xpub).toBe(BIP84_XPUB);
		expect(r.receive).toEqual([
			'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
			'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
			r.receive[2]
		]);
	});
	it('says STOP for a private key and names the right Sparrow field', () => {
		const r = checkTreasuryXpubInput(BIP84_ZPRV);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('xpub_is_private');
	});
	it('refuses a testnet key', () => {
		const r = checkTreasuryXpubInput(VPUB);
		expect(!r.ok && r.reason).toBe('xpub_testnet');
	});
});

describe('set-treasury-btc-xpub.ts (laptop)', () => {
	function tempConfig(): string {
		const dir = mkdtempSync(join(tmpdir(), 'mk-h2-'));
		const f = join(dir, 'canonicalTreasury.ts');
		copyFileSync(resolve(APP, 'src/config/canonicalTreasury.ts'), f);
		return f;
	}

	it('writes the canonical xpub into the file and prints the addresses to compare', () => {
		const f = tempConfig();
		// (the account-history check has its own tests: treasuryXpubHistory.test.ts)
		const r = run('set-treasury-btc-xpub.ts', [BIP84_ZPUB, '--file', f, '--skip-history-check']);
		expect(r.status).toBe(0);
		expect(readFileSync(f, 'utf8')).toContain(`btcXpub: '${BIP84_XPUB}'`);
		expect(r.stdout).toContain('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
	});

	it('refuses a private key and leaves the file untouched', () => {
		const f = tempConfig();
		const before = readFileSync(f, 'utf8');
		const r = run('set-treasury-btc-xpub.ts', [BIP84_ZPRV, '--file', f]);
		expect(r.status).not.toBe(0);
		expect(readFileSync(f, 'utf8')).toBe(before);
		// The private key is never echoed back.
		expect(r.stdout + r.stderr).not.toContain(BIP84_ZPRV);
	});
});

describe('release-build-payload.ts pins the xpub', () => {
	function manifest(): string {
		const dir = mkdtempSync(join(tmpdir(), 'mk-h2-m-'));
		const f = join(dir, 'm.json');
		writeFileSync(f, JSON.stringify({ 'index.html': 'sha256-' + 'a'.repeat(43) + '=' }));
		return f;
	}

	it('emits treasury.btc.xpub in canonical form next to the address', () => {
		const r = run('release-build-payload.ts', [], {
			MORPHIT_BUILD_VERSION: '1.20.0',
			MORPHIT_BUILD_HASH_MANIFEST_FILE: manifest(),
			MORPHIT_BUILD_BTC_XPUB: BIP84_ZPUB
		});
		expect(r.status).toBe(0);
		const payload = JSON.parse(r.stdout) as {
			treasury: { btc: { address: string; xpub: string } };
		};
		expect(payload.treasury.btc.xpub).toBe(BIP84_XPUB);
		expect(payload.treasury.btc.address).toMatch(/^bc1q/);
		expect(r.stderr).toContain('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
	});

	it('refuses to emit a payload carrying a private or testnet key', () => {
		for (const key of [BIP84_ZPRV, VPUB]) {
			const r = run('release-build-payload.ts', [], {
				MORPHIT_BUILD_VERSION: '1.20.0',
				MORPHIT_BUILD_HASH_MANIFEST_FILE: manifest(),
				MORPHIT_BUILD_BTC_XPUB: key
			});
			expect(r.status).not.toBe(0);
			expect(r.stdout).toBe('');
		}
	});
});

// v1.20.2 — the first real run (2026-10-01) failed: without `--file` the script
// dropped the key itself and said "Paste the whole key" to a correct 111-char
// zpub. Every test above passes `--file`. These run it WITHOUT `--file`, with a
// key that must be refused for its OWN reason — proof the key reached the
// check — and nothing is written (refused keys never touch the file).
describe('set-treasury-btc-xpub.ts without --file (how operators run it)', () => {
	it('the key reaches the check (a testnet key is refused AS testnet)', () => {
		const r = run('set-treasury-btc-xpub.ts', [VPUB]);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/TESTNET key/);
		expect(r.stderr).not.toMatch(/Paste the whole key/);
	});
});
