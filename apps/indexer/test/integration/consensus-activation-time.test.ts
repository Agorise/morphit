/**
 * The stricter consensus rules switch on by BLOCK TIMESTAMP: an op in a block
 * whose timestamp is at or after CONSENSUS_V2_ACTIVATION_TIME is judged by
 * them, one in a block a second earlier by the old ones, whatever the block
 * number. The timestamp is chain data, so every indexer — live, backfilling,
 * replaying a fast-sync snapshot or re-checking — reaches the same verdict.
 *
 * Real dispatcher, real handlers, real Postgres; four gated rules at the
 * boundary.
 */
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

type Op = [string, unknown];
const cj = (signer: string, id: string, json: unknown): Op => [
	'custom_json',
	{ required_auths: [], required_posting_auths: [signer], id, json: JSON.stringify(json) }
];

/** Blurt block timestamps carry no zone suffix (UTC). */
const chainStamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const AT = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
const BEFORE = chainStamp(AT - 1000);
const ON = chainStamp(AT);

let seq = 0;
async function verdictOf(
	fx: IntegrationFixture,
	blockNum: number,
	timestamp: string,
	op: Op
): Promise<string> {
	const c: pg.PoolClient = await fx.pool.connect();
	try {
		await c.query(`SET search_path TO "${fx.schema}"`);
		await c.query('BEGIN');
		await applyBlock(
			c,
			blockNum,
			{
				timestamp,
				transaction_ids: [`${blockNum}-${++seq}-`.padEnd(40, 'f')],
				transactions: [{ operations: [op] }]
			} as never,
			mockBlurt({}),
			fakeConfig({}),
			{},
			{},
			((a: number) => a) as never
		);
		await c.query('COMMIT');
	} finally {
		c.release();
	}
	const r = await fx.db.query<{ s: string }>(
		`SELECT status || ':' || COALESCE(reject_reason, '') AS s FROM ops WHERE block_num = $1`,
		[blockNum]
	);
	return r.rows[0]?.s ?? 'none';
}

const deep = (levels: number): unknown => {
	let v: unknown = 1;
	for (let i = 0; i < levels; i++) v = [v];
	return v;
};

const RULES: { name: string; op: () => Op; old: string; strict: string }[] = [
	{
		name: 'U+FFFF in an order (dispatcher)',
		op: () =>
			cj('alice', 'morphit_order_v1', {
				permlink: `nc-${seq}`,
				side: 'sell',
				asset: 'BTC',
				fiat_currency: 'USD',
				amount_min: 10,
				amount_max: 100,
				price_model: { kind: 'spread', percent: 1 },
				payment_methods: ['cash_in_person'],
				location_region: 'Berlin￿'
			}),
		old: 'applied:',
		strict: 'rejected:invalid_text'
	},
	{
		name: 'a payload nested 65 levels (dispatcher)',
		op: () => cj('alice', 'morphit_profile_v1', { display_name: 'x', extra: deep(64) }),
		old: 'applied:',
		strict: 'rejected:invalid_text'
	},
	{
		name: 'a javascript: profile link (profile handler)',
		op: () =>
			cj('alice', 'morphit_profile_v1', {
				display_name: 'Alice',
				json_metadata: { website_url: 'javascript:alert(1)' }
			}),
		old: 'applied:',
		strict: 'rejected:website_url_invalid'
	},
	{
		name: 'a malformed chat-read thread (chatRead handler)',
		op: () =>
			cj('alice', 'morphit_chat_read_v1', {
				peer: 'bob',
				last_read_at: '2026-10-01T00:00:00Z',
				order_permlink: 'Not A Permlink!'
			}),
		old: 'applied:',
		strict: 'rejected:order_permlink_invalid'
	}
];

describe.skipIf(!INTEGRATION_ENABLED)('consensus rules activate by block timestamp', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
	});

	for (const rule of RULES) {
		it(`${rule.name}: old rule one second before, new rule at the activation time`, async () => {
			expect(await verdictOf(fx, 500, BEFORE, rule.op())).toBe(rule.old);
			expect(await verdictOf(fx, 501, ON, rule.op())).toBe(rule.strict);
		});
	}

	it('the block number plays no part: a huge height with an earlier timestamp keeps the old rule', async () => {
		expect(await verdictOf(fx, 2_000_000_000, BEFORE, RULES[2]!.op())).toBe('applied:');
		expect(await verdictOf(fx, 600, ON, RULES[2]!.op())).toBe('rejected:website_url_invalid');
	});
});
