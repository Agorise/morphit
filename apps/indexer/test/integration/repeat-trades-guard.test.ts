/**
 * No silent gap in the v1.23.5 repeat-trade rule (repeatTradesGuard.ts). A
 * node that applied blocks stamped at or after the v1.23.5 activation time with
 * an older version — upgraded late, or rolled back for a while — refused
 * reviews of repeat trades every other node accepts; it must stop and say to
 * fast-sync or rebuild, not go on disagreeing. Judged by the chain's block
 * time. (The same shape as waiver-evidence-guard.test.ts.)
 *
 * Skips without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONSENSUS_V3_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import { checkRepeatTradesRule, RepeatTradesGapError } from '../../src/indexer/repeatTradesGuard';
import { markApplied } from '../../src/indexer/poller';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';

const AT = Date.parse(CONSENSUS_V3_ACTIVATION_TIME);
const BEFORE = new Date(AT - 60_000);
const AFTER = new Date(AT + 60_000);

describe.skipIf(!INTEGRATION_ENABLED)('the repeat-trade rule: no silent gap', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await fx.db.query(`DELETE FROM indexer_state`);
	});
	const state = async (last: number, through: number | null) =>
		fx.db.query(
			`INSERT INTO indexer_state (id, last_applied_block, chain_id, repeat_trades_through_block,
			                           review_signals_redo_due)
			 VALUES (1, $1, 'test', $2, FALSE)`,
			[last, through]
		);
	const through = async () =>
		(
			await fx.db.query<{ t: string | null }>(
				`SELECT repeat_trades_through_block::text AS t FROM indexer_state WHERE id = 1`
			)
		).rows[0]!.t;

	const redoDue = async () =>
		(
			await fx.db.query<{ d: boolean }>(
				`SELECT review_signals_redo_due AS d FROM indexer_state WHERE id = 1`
			)
		).rows[0]!.d;

	it('in step: nothing asked of the chain', async () => {
		await state(500, 500);
		const time = vi.fn(async () => AFTER);
		expect(await checkRepeatTradesRule(fx.db, time)).toBe('ok');
		expect(time).not.toHaveBeenCalled();
		expect(await redoDue()).toBe(false);
	});

	it('an upgrade before the activation time: the marker is set, the node goes on', async () => {
		await state(500, null);
		const time = vi.fn(async () => BEFORE);
		expect(await checkRepeatTradesRule(fx.db, time)).toBe('set');
		expect(time).toHaveBeenCalledWith(500);
		expect(await through()).toBe('500');
	});

	it('an upgrade AFTER blocks past the activation time were applied: the node stops, saying to fast-sync or rebuild', async () => {
		await state(500, null);
		const r = checkRepeatTradesRule(fx.db, async () => AFTER);
		await expect(r).rejects.toBeInstanceOf(RepeatTradesGapError);
		await expect(checkRepeatTradesRule(fx.db, async () => AFTER)).rejects.toThrow(
			/fast-sync[\s\S]*v1\.23\.5 or later[\s\S]*Rebuild the indexer's database/
		);
		expect(await through()).toBeNull();
	});

	it('a rollback that applied blocks past the activation time: stops too', async () => {
		await state(600, 500);
		await expect(checkRepeatTradesRule(fx.db, async () => AFTER)).rejects.toThrow(
			/blocks 501 to 600/
		);
	});

	it('a rollback that stayed before the activation time: catches up, goes on', async () => {
		await state(600, 500);
		expect(await checkRepeatTradesRule(fx.db, async () => BEFORE)).toBe('set');
		expect(await through()).toBe('600');
		// The older version may have raised review-ring flags: looked at again.
		expect(await redoDue()).toBe(true);
	});

	it('the chain cannot be asked: no verdict (the poller asks again), nothing written', async () => {
		await state(500, null);
		await expect(
			checkRepeatTradesRule(fx.db, async () => {
				throw new Error('rpc down');
			})
		).rejects.toThrow('rpc down');
		expect(await through()).toBeNull();
	});

	it('the poller keeps it in step while it applies blocks — and a gap stays a gap', async () => {
		await state(100, 100);
		const client = await fx.pool.connect();
		try {
			await client.query(`SET search_path TO ${fx.schema}`);
			await markApplied(client, 101);
			expect(await through()).toBe('101');
			await client.query(`UPDATE indexer_state SET repeat_trades_through_block = 90`);
			await markApplied(client, 102);
			expect(await through()).toBe('90');
		} finally {
			client.release();
		}
	});
});
