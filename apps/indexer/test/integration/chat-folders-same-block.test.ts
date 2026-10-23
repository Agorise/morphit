/**
 * Two folder updates in one block: the later one wins (v1.21.14 full chat
 * audit, S-L4). The upsert compared blocks with a strict `<`, so the FIRST of
 * two ops in one block was kept and the user's newer folder state was lost.
 * Real Postgres, the real handler.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import handler from '../../src/indexer/handlers/chatFolders';
import { makeCtx } from '../testutils/context';

describe.skipIf(!INTEGRATION_ENABLED)('chat folders: latest op wins', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => fx?.teardown());
	beforeEach(async () => {
		await fx.db.query('DELETE FROM chat_folders');
	});

	const apply = (enc: string, blockNum: number) =>
		fx.db.withTx(async (client) =>
			handler(
				makeCtx({ signer: 'alice', blockNum, trxId: `t-${enc}`, payload: { v: 1, enc } }),
				client
			)
		);
	const stored = async () =>
		(await fx.db.query<{ enc: string }>(`SELECT enc FROM chat_folders WHERE account='alice'`))
			.rows[0]?.enc;

	it('the second of two ops in the same block is kept', async () => {
		await apply('Zmlyc3Q=', 100);
		await apply('c2Vjb25k', 100);
		expect(await stored()).toBe('c2Vjb25k');
	});

	it('an op from an older block never replaces a newer one', async () => {
		await apply('bmV3ZXI=', 101);
		await apply('b2xkZXI=', 100);
		expect(await stored()).toBe('bmV3ZXI=');
	});
});
