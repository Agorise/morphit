/**
 * (A1 part) and (A10, C4) — behavioural guards.
 *
 *  - a release's hash-manifest KEYS must be plain same-site paths. The
 *    browser fetches every key to hash it, so a signed manifest holding
 *    `//evil.example/x` made every page load request another host (WP-2).
 *  - a manifest VALUE must be exactly one SRI sha256 — nothing may
 *    follow it (the `$` anchor; a mutant without it survived every check).
 *  - a BTC/XMR txid is stored lower-cased, so the same payment in
 *    another letter case is caught as reuse (a mutant dropping the
 *    lower-casing survived every check).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateReleasePayload } from '@morphit/release-schema';
import { applyBlock } from '../../src/indexer/dispatcher';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

const H = 'sha256-' + 'a'.repeat(43) + '=';
const release = (manifest: Record<string, string>) => ({
	version: '1.20.4',
	hash_manifest: manifest
});
const verdict = (manifest: Record<string, string>) => {
	const r = validateReleasePayload(release(manifest));
	return r.ok ? 'ok' : r.reason;
};

describe('release hash-manifest keys and values', () => {
	it('accepts plain build paths, with or without the leading slash', () => {
		expect(
			verdict({ 'index.html': H, '_app/immutable/entry/start.Bx1.js': H, '/favicon.png': H })
		).toBe('ok');
	});

	for (const key of [
		'//evil.example/x',
		'https://evil.example/x',
		'http://127.0.0.1:8080/admin',
		'/a?b=c',
		'/a#frag',
		'/a b',
		'\\\\evil.example\\x',
		'x'.repeat(201)
	]) {
		it(`refuses the key ${JSON.stringify(key.slice(0, 40))}`, () => {
			expect(verdict({ 'index.html': H, [key]: H })).toBe('hash_manifest_entry_invalid');
		});
	}

	it('refuses a value with anything after the hash', () => {
		expect(verdict({ 'index.html': `${H}x` })).toBe('hash_manifest_entry_invalid');
		expect(verdict({ 'index.html': `${H}\nsha256-zzz` })).toBe('hash_manifest_entry_invalid');
	});
});

describe.skipIf(!INTEGRATION_ENABLED)('a fee txid is compared case-insensitively', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it('the same BTC payment in upper case is caught as reuse, and stored lower-cased', async () => {
		const txid = 'ab'.repeat(32);
		const ops = [
			['alice', txid.toUpperCase()],
			['bob', txid]
		].map(([who, t]) => [
			'custom_json',
			{
				required_auths: [],
				required_posting_auths: [who],
				id: 'morphit_order_v1',
				json: JSON.stringify({
					permlink: `${who}-btc`,
					side: 'sell',
					asset: 'BTC',
					fiat_currency: 'USD',
					amount_min: 10,
					amount_max: 100,
					price_model: { kind: 'spread', percent: 1 },
					payment_methods: ['cash_in_person'],
					fee_method: 'btc',
					external_tx_id: t
				})
			}
		]);
		const c: pg.PoolClient = await fx.pool.connect();
		try {
			await c.query(`SET search_path TO "${fx.schema}"`);
			await c.query('BEGIN');
			await applyBlock(
				c,
				200,
				{
					timestamp: '2026-10-01T00:00:00',
					transaction_ids: ['t0'.padEnd(40, '0'), 't1'.padEnd(40, '0')],
					transactions: ops.map((op) => ({ operations: [op] }))
				} as never,
				mockBlurt({}),
				fakeConfig({}),
				{
					btc: { name: 'stub', verify: async () => ({ kind: 'pending_external', reason: 'x' }) }
				},
				{ btcSatoshis: 416 },
				((a: number) => a) as never
			);
			await c.query('COMMIT');
		} finally {
			c.release();
		}
		const rows = await fx.db.query<{
			account: string;
			fee_status: string;
			external_tx_id: string | null;
		}>(`SELECT account, fee_status, external_tx_id FROM orders ORDER BY account`);
		expect(rows.rows).toEqual([
			{ account: 'alice', fee_status: 'pending_external', external_tx_id: txid },
			{ account: 'bob', fee_status: 'reused', external_tx_id: null }
		]);
	});
});
