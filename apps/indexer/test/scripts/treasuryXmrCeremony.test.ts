/**
 * v1.20.0 (MK-H2) — getting the treasury Monero PRIMARY address into the
 * release op (bound XMR fees).
 *
 * The maintainer's laptop steps: `set-treasury-xmr-primary.ts <address>` writes it into
 * CANONICAL_TREASURY.xmrPrimary (refusing subaddresses, integrated addresses,
 * testnet/stagenet, typos and addresses that hold no valid keys), and the
 * release-op builder pins it as treasury.xmr.primary_address. Both print a
 * sample integrated address the maintainer compares with the wallet's
 * `integrated_address <payment id>`. The expected sample below was made by
 * the PyPI `monero` package (Address.with_payment_id), not by our code.
 * These tests run the REAL scripts.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTreasuryXmrPrimaryInput } from '../../src/lib/treasuryXmrPrimaryInput';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP = resolve(HERE, '../..');
const TSX = resolve(APP, '../../node_modules/.bin/tsx');

const PRIMARY =
	'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy';
// PyPI monero: keccak("morphit-fee-v1|morphit/treasury-check")[0:8] and
// Address(PRIMARY).with_payment_id(it)
const SAMPLE_PID = '03159a89a2d9096c';
const SAMPLE_INTEGRATED =
	'4Dp9BhCqXPR8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL4D3cDChHXgvUDJCUPuP';
const SUBADDRESS =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const STAGENET =
	'54KWFjJJZj18bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL4994X7Gg';
const TESTNET =
	'9uf1f93cCV18bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49Ciuugh';
// Checksum-valid mainnet standard address whose spend key is not a curve point.
const NOT_A_POINT =
	'41hWDGhXn87111111111111111111111111111111111179BQQBKGRWBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49BDEbtt';
const TYPO = PRIMARY.slice(0, 40) + (PRIMARY[40] === 'a' ? 'b' : 'a') + PRIMARY.slice(41);

function run(script: string, args: string[], env: Record<string, string> = {}) {
	return spawnSync(TSX, [resolve(APP, 'scripts', script), ...args], {
		cwd: resolve(APP, '../..'),
		env: { ...process.env, ...env },
		input: '',
		encoding: 'utf8',
		timeout: 60_000
	});
}

describe('treasury XMR primary address check', () => {
	it('accepts a mainnet primary address and makes the same sample integrated address as PyPI monero', () => {
		const r = checkTreasuryXmrPrimaryInput(`  ${PRIMARY}\n`);
		expect(r).toMatchObject({
			ok: true,
			address: PRIMARY,
			sample: { paymentId: SAMPLE_PID, integrated: SAMPLE_INTEGRATED }
		});
	});
	it.each([
		[SUBADDRESS, 'xmr_primary_is_subaddress'],
		[SAMPLE_INTEGRATED, 'xmr_primary_is_integrated'],
		[STAGENET, 'xmr_primary_wrong_network'],
		[TESTNET, 'xmr_primary_wrong_network'],
		[TYPO, 'xmr_address_bad_checksum'],
		[NOT_A_POINT, 'xmr_primary_bad_key']
	])('refuses %s → %s', (addr, reason) => {
		const r = checkTreasuryXmrPrimaryInput(addr);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe(reason);
	});
});

describe('set-treasury-xmr-primary.ts (laptop)', () => {
	function tempConfig(): string {
		const dir = mkdtempSync(join(tmpdir(), 'mk-h2-xmr-'));
		const f = join(dir, 'canonicalTreasury.ts');
		copyFileSync(resolve(APP, 'src/config/canonicalTreasury.ts'), f);
		return f;
	}

	it('writes the primary address and prints the sample to compare with the wallet', () => {
		const f = tempConfig();
		const r = run('set-treasury-xmr-primary.ts', [PRIMARY, '--file', f]);
		expect(r.status).toBe(0);
		expect(readFileSync(f, 'utf8')).toContain(`xmrPrimary: '${PRIMARY}'`);
		expect(r.stdout).toContain(`integrated_address ${SAMPLE_PID}`);
		expect(r.stdout).toContain(SAMPLE_INTEGRATED);
	});

	it('refuses a subaddress and leaves the file untouched', () => {
		const f = tempConfig();
		const before = readFileSync(f, 'utf8');
		const r = run('set-treasury-xmr-primary.ts', [SUBADDRESS, '--file', f]);
		expect(r.status).not.toBe(0);
		expect(readFileSync(f, 'utf8')).toBe(before);
		expect(r.stderr).toContain('SUBADDRESS');
	});
});

describe('release-build-payload.ts pins the primary address', () => {
	function manifest(): string {
		const dir = mkdtempSync(join(tmpdir(), 'mk-h2-xmr-m-'));
		const f = join(dir, 'm.json');
		writeFileSync(f, JSON.stringify({ 'index.html': 'sha256-' + 'a'.repeat(43) + '=' }));
		return f;
	}

	it('emits treasury.xmr.primary_address next to the fee address and prints the sample', () => {
		const r = run('release-build-payload.ts', [], {
			MORPHIT_BUILD_VERSION: '1.20.0',
			MORPHIT_BUILD_HASH_MANIFEST_FILE: manifest(),
			MORPHIT_BUILD_XMR_PRIMARY: PRIMARY
		});
		expect(r.status).toBe(0);
		const payload = JSON.parse(r.stdout) as {
			treasury: { xmr: { address: string; primary_address: string } };
		};
		expect(payload.treasury.xmr.primary_address).toBe(PRIMARY);
		expect(payload.treasury.xmr.address).toBe(SUBADDRESS);
		expect(r.stderr).toContain(SAMPLE_INTEGRATED);
	});

	it('refuses to emit a payload pinning a subaddress or a testnet address as the primary', () => {
		for (const bad of [SUBADDRESS, TESTNET]) {
			const r = run('release-build-payload.ts', [], {
				MORPHIT_BUILD_VERSION: '1.20.0',
				MORPHIT_BUILD_HASH_MANIFEST_FILE: manifest(),
				MORPHIT_BUILD_XMR_PRIMARY: bad
			});
			expect(r.status).not.toBe(0);
			expect(r.stdout).toBe('');
		}
	});
});

// v1.20.2 — same bug as the xpub script: without `--file` the address itself
// was dropped ("Paste the whole main address"). Run WITHOUT `--file`, with an
// address refused for its own reason; nothing is written.
describe('set-treasury-xmr-primary.ts without --file (how operators run it)', () => {
	it('the address reaches the check (a subaddress is refused as a subaddress)', () => {
		const r = run('set-treasury-xmr-primary.ts', [SUBADDRESS]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('SUBADDRESS');
	});
});
