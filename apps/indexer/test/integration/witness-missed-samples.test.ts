/**
 * witness_missed_samples (schema v72) on a real PostgreSQL (v1.23.0): the
 * /witnesses page's sampler writes each producing witness's missed total, the
 * list reads the baseline a day back (or the oldest when it has watched for
 * less), and rows over 26 hours old are deleted. The unit tests stub the SQL;
 * this runs it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { SAMPLE_KEEP_MS, WitnessService } from '../../src/indexer/witnessService';

const HEAD = 65_087_002;
const KEY = 'BLT8F2MsdPmACkzSCnRuCmm1Qz6rQdNDqBZSFCNZJCGn5ACwruVS9';
const H = 3_600_000;

const witness = (owner: string, total_missed: number, extra: Record<string, unknown> = {}) => ({
	owner,
	created: '2022-10-01T21:41:42',
	url: 'https://blurt.pl',
	votes: '1000000000000',
	total_missed,
	last_confirmed_block_num: HEAD - 10,
	signing_key: KEY,
	running_version: '0.9.1',
	...extra
});

describe.skipIf(!INTEGRATION_ENABLED)('witness_missed_samples (v72)', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it('writes, reads the baseline a day back, falls back to the oldest, prunes', async () => {
		let now = Date.parse('2026-11-05T00:00:00Z');
		let list = [
			witness('khrom', 100),
			witness('fervi', 50),
			witness('eastmael', 7, { signing_key: 'BLT1111111111111111111111111111111114T1Anm' })
		];
		const blurt = {
			callCondenser: async () => list,
			getDynamicGlobalProperties: async () => ({
				head_block_number: HEAD,
				last_irreversible_block_num: HEAD - 20,
				total_vesting_fund_blurt: '396540355.664 BLURT',
				total_vesting_shares: '344824578.602727 VESTS'
			}),
			getAccounts: async () => new Map()
		};
		const svc = () =>
			new WitnessService({
				blurt: blurt as never,
				db: fx.db,
				apiDb: fx.db,
				now: () => now,
				avatarsAllowed: () => false
			});

		// Day-old sample, then one 3 h later, then now.
		await svc().sample();
		now += 3 * H;
		list = [witness('khrom', 101), witness('fervi', 50)];
		await svc().sample();
		now += 21 * H;
		list = [witness('khrom', 104), witness('fervi', 52)];
		await svc().sample();

		const rows = await fx.db.query<{ owner: string; n: string }>(
			`SELECT owner, count(*)::text AS n FROM witness_missed_samples GROUP BY owner ORDER BY owner`
		);
		// The switched-off witness is never sampled.
		expect(rows.rows).toEqual([
			{ owner: 'fervi', n: '3' },
			{ owner: 'khrom', n: '3' }
		]);

		// Baseline exactly 24 h back: khrom 104 − 100, fervi 52 − 50.
		const body = await svc().getList();
		const by = (o: string) => body.witnesses.find((w) => w.owner === o)!;
		expect(by('khrom').missed_recent).toBe(4);
		expect(by('khrom').missed_window_hours).toBe(24);
		expect(by('fervi').missed_recent).toBe(2);

		// A witness first seen 5 h ago: the oldest sample, and the hours said.
		await fx.db.query(
			`INSERT INTO witness_missed_samples (owner, sampled_at, total_missed) VALUES ('node01', $1, 30)`,
			[new Date(now - 5 * H).toISOString()]
		);
		list = [witness('khrom', 104), witness('fervi', 52), witness('node01', 31)];
		now += 61_000; // past the list's one-minute cache
		const body2 = await svc().getList();
		const n1 = body2.witnesses.find((w) => w.owner === 'node01')!;
		expect(n1.missed_recent).toBe(1);
		expect(n1.missed_window_hours).toBe(5);

		// 26 h after the first sample it is deleted, the others are kept.
		now = Date.parse('2026-11-05T00:00:00Z') + SAMPLE_KEEP_MS + 1;
		await svc().sample();
		const left = await fx.db.query<{ sampled_at: Date }>(
			`SELECT sampled_at FROM witness_missed_samples WHERE owner = 'khrom' ORDER BY sampled_at`
		);
		expect(left.rows.map((r) => r.sampled_at.toISOString())).toEqual([
			'2026-11-05T03:00:00.000Z',
			'2026-11-06T00:00:00.000Z',
			new Date(now).toISOString()
		]);
	});

	it('a sample twice at the same instant is one row, and a negative total is refused', async () => {
		const at = '2026-11-07T00:00:00Z';
		await fx.db.query(
			`INSERT INTO witness_missed_samples (owner, sampled_at, total_missed) VALUES ('dup', $1, 1)`,
			[at]
		);
		await fx.db.query(
			`INSERT INTO witness_missed_samples (owner, sampled_at, total_missed)
			 SELECT o, $1::timestamptz, m FROM UNNEST($2::text[], $3::bigint[]) AS t(o, m)
			 ON CONFLICT (owner, sampled_at) DO NOTHING`,
			[at, ['dup'], [2]]
		);
		const r = await fx.db.query<{ total_missed: string }>(
			`SELECT total_missed FROM witness_missed_samples WHERE owner = 'dup'`
		);
		expect(r.rows.map((x) => x.total_missed)).toEqual(['1']);
		await expect(
			fx.db.query(
				`INSERT INTO witness_missed_samples (owner, sampled_at, total_missed) VALUES ('neg', now(), -1)`
			)
		).rejects.toThrow();
	});
});
