/**
 * v1.20.2 — the treasury BTC key must belong to an account that has never been
 * used (lib/treasuryXpubHistory.ts). The first real run (2026-10-01) pasted the
 * key of the account holding the shared treasury address (its receive #15),
 * and the setter saved it: an order given an already-funded address would
 * have looked paid. The explorer answers below are REAL ones (blockstream.info
 * and mempool.space, 2026-10-01): the BIP84 test-vector key's receive #0 has
 * 176 transactions on mainnet; a fresh account's #0 has none.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveBtcFeeAddress } from '@morphit/release-schema';
import { esploraTxCount, scanXpubHistory } from '../../src/lib/treasuryXpubHistory';
import { parseTreasuryArgs } from '../../src/lib/treasuryCliArgs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APP = resolve(HERE, '../..');
const ROOT = resolve(APP, '../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

// BIP84 test vector (mnemonic "abandon … about"): public, and used on mainnet.
const BIP84_ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const BIP84_XPUB =
	'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
const BIP84_R0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';

const REAL_USED = {
	address: BIP84_R0,
	chain_stats: {
		funded_txo_count: 88,
		funded_txo_sum: 4082661,
		spent_txo_count: 88,
		spent_txo_sum: 4082661,
		tx_count: 176
	},
	mempool_stats: {
		funded_txo_count: 0,
		funded_txo_sum: 0,
		spent_txo_count: 0,
		spent_txo_sum: 0,
		tx_count: 0
	}
};
const fresh = (address: string) => ({
	address,
	chain_stats: {
		funded_txo_count: 0,
		funded_txo_sum: 0,
		spent_txo_count: 0,
		spent_txo_sum: 0,
		tx_count: 0
	},
	mempool_stats: {
		funded_txo_count: 0,
		funded_txo_sum: 0,
		spent_txo_count: 0,
		spent_txo_sum: 0,
		tx_count: 0
	}
});

describe('esploraTxCount — reading an explorer answer', () => {
	it('the real answers: 176 for a used address, 0 for a fresh one', () => {
		expect(esploraTxCount(REAL_USED, BIP84_R0)).toBe(176);
		const f = 'bc1qzwnl4xd54gnu5waup8ytcfygrq2tg0mr0gw8w5';
		expect(esploraTxCount(fresh(f), f)).toBe(0);
	});
	it('a payment still in the mempool counts as used', () => {
		const a = fresh(BIP84_R0);
		const pending = {
			...a,
			mempool_stats: { ...a.mempool_stats, tx_count: 1, funded_txo_count: 1 }
		};
		expect(esploraTxCount(pending, BIP84_R0)).toBe(1);
	});
	it('anything that is not an answer about THIS address is no answer', () => {
		expect(esploraTxCount('<html>rate limited</html>', BIP84_R0)).toBeNull();
		expect(esploraTxCount({}, BIP84_R0)).toBeNull();
		expect(esploraTxCount({ chain_stats: { tx_count: 0 } }, BIP84_R0)).toBeNull();
		expect(esploraTxCount(fresh('bc1qother'), BIP84_R0)).toBeNull();
		expect(
			esploraTxCount({ ...fresh(BIP84_R0), chain_stats: { tx_count: -1 } }, BIP84_R0)
		).toBeNull();
	});
});

type Answer = (address: string) => { status: number; body: unknown } | 'hang';
const fakeFetch = (perBase: Record<string, Answer>, asked: string[] = []): typeof fetch =>
	(async (url: string | URL) => {
		const u = String(url);
		asked.push(u);
		const base = Object.keys(perBase).find((b) => u.startsWith(b));
		const address = u.slice(u.lastIndexOf('/') + 1);
		const a = base ? perBase[base]!(address) : 'hang';
		if (a === 'hang') throw new Error('connect ECONNREFUSED');
		return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), {
			status: a.status
		});
	}) as typeof fetch;

const at = (i: number) => deriveBtcFeeAddress(BIP84_XPUB, i);

describe('scanXpubHistory — receive #0 … #19, first use refuses', () => {
	it('all twenty fresh → fresh', async () => {
		const asked: string[] = [];
		const r = await scanXpubHistory(at, {
			explorers: ['https://a/api'],
			fetchImpl: fakeFetch({ 'https://a/api': (x) => ({ status: 200, body: fresh(x) }) }, asked)
		});
		expect(r).toEqual({ kind: 'fresh', checked: 20 });
		expect(asked).toHaveLength(20);
		expect(asked[0]).toBe(`https://a/api/address/${BIP84_R0}`);
	});
	it('a used #7 refuses at #7, naming it', async () => {
		const used = at(7);
		const r = await scanXpubHistory(at, {
			explorers: ['https://a/api'],
			fetchImpl: fakeFetch({
				'https://a/api': (x) => ({
					status: 200,
					body: x === used ? { ...REAL_USED, address: used } : fresh(x)
				})
			})
		});
		expect(r).toEqual({
			kind: 'used',
			index: 7,
			address: used,
			txCount: 176,
			explorer: 'https://a/api'
		});
	});
	it('a dead or rate-limiting first explorer falls through to the next', async () => {
		const r = await scanXpubHistory(at, {
			explorers: ['https://dead/api', 'https://limit/api/', 'https://ok/api'],
			fetchImpl: fakeFetch({
				'https://dead/api': () => 'hang',
				'https://limit/api': () => ({ status: 429, body: 'Too Many Requests' }),
				'https://ok/api': (x) => ({ status: 200, body: x === BIP84_R0 ? REAL_USED : fresh(x) })
			})
		});
		expect(r.kind).toBe('used');
	});
	it('no explorer answers → UNCHECKED, never fresh', async () => {
		const r = await scanXpubHistory(at, {
			explorers: ['https://dead/api'],
			fetchImpl: fakeFetch({ 'https://dead/api': () => 'hang' })
		});
		expect(r).toEqual({ kind: 'unchecked', index: 0, address: BIP84_R0 });
	});
});

describe('parseTreasuryArgs', () => {
	it('key, repeated --explorer, --file and the flag, in any order; typos reported', () => {
		const p = parseTreasuryArgs(
			[
				'--explorer',
				'https://a',
				'KEY',
				'--skip-history-check',
				'--explorer',
				'https://b',
				'--fil'
			],
			['file', 'explorer'],
			['skip-history-check']
		);
		expect(p.value).toBe('KEY');
		expect(p.options.explorer).toEqual(['https://a', 'https://b']);
		expect(p.flags.has('skip-history-check')).toBe(true);
		expect(p.unknown).toEqual(['--fil']);
	});
});

// ── the REAL script, against a local explorer ────────────────────────────────

let server: Server | null = null;
afterEach(async () => {
	if (server) await new Promise<void>((r) => server!.close(() => r()));
	server = null;
});

async function explorer(answer: (address: string) => unknown): Promise<string> {
	server = createServer((req, res) => {
		const m = /^\/api\/address\/([a-z0-9]+)$/.exec(req.url ?? '');
		if (!m) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer(m[1]!)));
	});
	await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const c = spawn(TSX, ['apps/indexer/scripts/set-treasury-btc-xpub.ts', ...args], {
			cwd: ROOT,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		c.stdout.on('data', (d) => (stdout += d));
		c.stderr.on('data', (d) => (stderr += d));
		const t = setTimeout(() => c.kill('SIGKILL'), 60_000);
		c.on('close', (status) => {
			clearTimeout(t);
			done({ status, stdout, stderr });
		});
	});
}

function tempConfig(): string {
	const dir = mkdtempSync(join(tmpdir(), 'xpub-hist-'));
	const f = join(dir, 'canonicalTreasury.ts');
	copyFileSync(resolve(APP, 'src/config/canonicalTreasury.ts'), f);
	// start from "no key pinned" whatever the repo copy holds
	const src = readFileSync(f, 'utf8').replace(/^(\s*btcXpub:\s*)'[^'\n]*'/m, "$1''");
	writeFileSync(f, src);
	return f;
}

describe('set-treasury-btc-xpub.ts refuses a used account (run as documented, from the repo root)', () => {
	it('a used account (the real 2026-10-01 mistake) is NOT saved, and says why', async () => {
		const url = await explorer((x) => (x === BIP84_R0 ? REAL_USED : fresh(x)));
		const f = tempConfig();
		const before = readFileSync(f, 'utf8');
		const r = await run([BIP84_ZPUB, '--file', f, '--explorer', url]);
		expect(r.status).toBe(1);
		expect(readFileSync(f, 'utf8')).toBe(before);
		expect(r.stderr).toContain('already been used');
		expect(r.stderr).toContain(`receive #0  ${BIP84_R0}  has 176 transaction(s)`);
		expect(r.stdout).not.toContain('saved');
	}, 90_000);

	it('a fresh account is checked (#0–#19) and saved', async () => {
		const seen = new Set<string>();
		const url = await explorer((x) => {
			seen.add(x);
			return fresh(x);
		});
		const f = tempConfig();
		const r = await run([BIP84_ZPUB, '--file', f, '--explorer', url]);
		expect(r.status).toBe(0);
		expect(seen.size).toBe(20);
		expect(r.stdout).toContain('Never used: receive #0–#19 have no transactions.');
		expect(readFileSync(f, 'utf8')).toContain(`btcXpub: '${BIP84_XPUB}'`);
	}, 90_000);

	it('no explorer reachable → NOT saved; --skip-history-check saves with a warning', async () => {
		const f = tempConfig();
		const before = readFileSync(f, 'utf8');
		const dead = 'http://127.0.0.1:9/api';
		const r = await run([BIP84_ZPUB, '--file', f, '--explorer', dead]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('Could not check receive #0');
		expect(readFileSync(f, 'utf8')).toBe(before);
		const s = await run([BIP84_ZPUB, '--file', f, '--explorer', dead, '--skip-history-check']);
		expect(s.status).toBe(0);
		expect(s.stdout).toContain('History check SKIPPED');
		expect(readFileSync(f, 'utf8')).toContain(`btcXpub: '${BIP84_XPUB}'`);
	}, 90_000);

	it('re-running with the key already saved changes nothing and asks no explorer', async () => {
		const f = tempConfig();
		const dead = 'http://127.0.0.1:9/api';
		await run([BIP84_ZPUB, '--file', f, '--skip-history-check']);
		const saved = readFileSync(f, 'utf8');
		const r = await run([BIP84_ZPUB, '--file', f, '--explorer', dead]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('already saved');
		expect(readFileSync(f, 'utf8')).toBe(saved);
	}, 90_000);

	it('a mistyped option is refused, not read as the key', async () => {
		const f = tempConfig();
		const r = await run([BIP84_ZPUB, '--file', f, '--skip-history']);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('Unknown option --skip-history');
	}, 90_000);
});
