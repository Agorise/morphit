/**
 * (A1 part) — a profile's display name can be cleared.
 *
 * Before: an empty display_name meant "no name in this op" and the upsert kept
 * the stored one, and null was refused, so a name could never be removed even
 * though the settings page offered it. From CONSENSUS_V2_ACTIVATION_TIME an
 * explicit `display_name: null` clears it; an empty string still leaves it.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

const ACTIVATION = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);

/** A profile op in block `n`, stamped `secondsAfter` the activation time. */
async function profileOp(
	fx: IntegrationFixture,
	n: number,
	secondsAfter: number,
	payload: unknown
): Promise<string> {
	const c: pg.PoolClient = await fx.pool.connect();
	try {
		await c.query(`SET search_path TO "${fx.schema}"`);
		await c.query('BEGIN');
		await applyBlock(
			c,
			n,
			{
				timestamp: new Date(ACTIVATION + secondsAfter * 1000).toISOString().slice(0, 19),
				transaction_ids: [`${n}`.padEnd(40, 'f')],
				transactions: [
					{
						operations: [
							[
								'custom_json',
								{
									required_auths: [],
									required_posting_auths: ['sally'],
									id: 'morphit_profile_v1',
									json: JSON.stringify(payload)
								}
							]
						]
					}
				]
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
	const op = await fx.db.query<{ s: string }>(
		`SELECT status || ':' || COALESCE(reject_reason, '') AS s FROM ops WHERE block_num = $1`,
		[n]
	);
	return op.rows[0]!.s;
}

const nameOf = async (fx: IntegrationFixture) =>
	(
		await fx.db.query<{ n: string }>(
			`SELECT display_name AS n FROM profiles WHERE account = 'sally'`
		)
	).rows[0]?.n;

describe.skipIf(!INTEGRATION_ENABLED)('clearing a display name', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it('from the activation time: "" keeps the name, null clears it, the rest of the profile stays', async () => {
		expect(
			await profileOp(fx, 201, 0, { display_name: 'Sally', json_metadata: { short_bio: 'hi' } })
		).toBe('applied:');
		expect(await profileOp(fx, 202, 3, { display_name: '' })).toBe('applied:');
		expect(await nameOf(fx)).toBe('Sally');
		expect(await profileOp(fx, 203, 6, { display_name: null })).toBe('applied:');
		expect(await nameOf(fx)).toBe('');
		const meta = await fx.db.query<{ b: string }>(
			`SELECT json_metadata->>'short_bio' AS b FROM profiles WHERE account = 'sally'`
		);
		expect(meta.rows[0]?.b).toBe('hi');
	});

	it('before the activation time null is refused, as it always was', async () => {
		expect(await profileOp(fx, 100, -1, { display_name: null })).toBe(
			'rejected:display_name_not_string'
		);
	});
});
