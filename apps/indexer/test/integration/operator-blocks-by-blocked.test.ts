/**
 * /v1/operator-blocks/by-blocked/:account answers for THIS instance's operator
 * only (A2 part), on real Postgres.
 *
 * Every operator's chain-origin blocks are indexed. The route returned the
 * newest block against the account by ANY operator, so a user was told they
 * were blocked here because another instance blocked them — and that other
 * operator's list and reasons were republished by every instance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { operatorBlocksRoute } from '../../src/api/operatorBlocks';

describe.skipIf(!INTEGRATION_ENABLED)('by-blocked is about this instance', () => {
	let fx: IntegrationFixture;

	const block = (operator: string, blocked: string, reason: string) =>
		fx.db.query(
			`INSERT INTO operator_blocks (operator, blocked, state, reason, since_block_num, since_trx_id,
			                             last_action_block_num, created_at, updated_at)
			 VALUES ($1, $2, 'blocked', $3, 1, 't', 1, NOW(), NOW())`,
			[operator, blocked, reason]
		);

	beforeAll(async () => {
		fx = await setupWithMigrations();
		await block('elsewhere', 'alice', 'their reason');
		await block('elsewhere', 'bob', 'their reason');
		await block('here', 'bob', 'our reason');
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	const ask = async (account: string) =>
		(await (await operatorBlocksRoute(fx.db, 'here').request(`/by-blocked/${account}`)).json()) as {
			blocked: boolean;
			operator?: string;
			reason?: string;
		};

	it('another operator’s block is not reported as a block here', async () => {
		expect(await ask('alice')).toEqual({ account: 'alice', blocked: false });
	});

	it('our own block is, with our reason', async () => {
		const r = await ask('bob');
		expect([r.blocked, r.operator, r.reason]).toEqual([true, 'here', 'our reason']);
	});
});
