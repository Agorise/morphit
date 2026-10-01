/**
 * v1.20.2 — the XMR self-test runs from the REPO ROOT, as docs/OPERATIONS.md
 * §40.13 and the script's own header say. In v1.20.0/v1.20.1 it imported
 * through the indexer's `$indexer/…` path alias, which tsx resolves only from
 * apps/indexer's own tsconfig, so the documented command stopped with
 * "Cannot find package '$indexer'" before printing anything (2026-10-01).
 * These tests run the REAL script with the documented working directory.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP = resolve(HERE, '../..');
const ROOT = resolve(APP, '../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

const PRIMARY =
	'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy';
// PyPI monero: Address(PRIMARY).with_payment_id(keccak("morphit-fee-v1|morphit/treasury-check")[0:8])
const SAMPLE_INTEGRATED =
	'4Dp9BhCqXPR8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL4D3cDChHXgvUDJCUPuP';

function runFromRoot(args: string[]) {
	return spawnSync(TSX, ['apps/indexer/scripts/xmr-fee-selftest.ts', ...args], {
		cwd: ROOT,
		input: '',
		encoding: 'utf8',
		timeout: 60_000
	});
}

describe('xmr-fee-selftest.ts, run from the repo root as documented', () => {
	it('prints where to send the test payment (the PyPI-made integrated address)', () => {
		const r = runFromRoot([
			'--account',
			'morphit',
			'--permlink',
			'treasury-check',
			'--primary',
			PRIMARY
		]);
		expect(r.stderr).not.toContain('Cannot find package');
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('Send exactly 781250000 piconero');
		expect(r.stdout).toContain(SAMPLE_INTEGRATED);
	});
	it('a malformed tx key is refused before any explorer is asked', () => {
		const r = runFromRoot([
			'--txid',
			'zz',
			'--txkey',
			'zz',
			'--account',
			'morphit',
			'--permlink',
			'treasury-check',
			'--primary',
			PRIMARY,
			'--explorer',
			'https://127.0.0.1:9'
		]);
		expect(r.stderr).not.toContain('Cannot find package');
		expect(r.status).toBe(1);
		expect(r.stdout).toMatch(/64 hex/);
	});
});
