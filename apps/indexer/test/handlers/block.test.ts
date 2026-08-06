import { describe, expect, it } from 'vitest';

import handler from '$indexer/handlers/block';
import { makeCtx } from '../testutils/context';
import { makeMockClient } from '../testutils/mockClient';

describe('block handler', () => {
	describe('validation', () => {
		it('rejects non-object payload', async () => {
			const mock = makeMockClient();
			const r = await handler(
				makeCtx({ signer: 'alice', payload: 'not an object' as unknown }),
				mock.client
			);
			expect(r).toEqual({ ok: false, reason: 'payload_not_object' });
			expect(mock.queries).toHaveLength(0);
		});

		it('rejects array payload', async () => {
			const mock = makeMockClient();
			const r = await handler(makeCtx({ signer: 'alice', payload: [] as unknown }), mock.client);
			expect(r).toEqual({ ok: false, reason: 'payload_not_object' });
		});

		it('rejects invalid blocked account name', async () => {
			const mock = makeMockClient();
			for (const bad of ['X', 'ALICE', '1badstart', '', '!@#']) {
				const r = await handler(
					makeCtx({
						signer: 'alice',
						payload: { blocked: bad, action: 'block' }
					}),
					mock.client
				);
				expect(r).toEqual({ ok: false, reason: 'blocked_invalid' });
			}
		});

		it('rejects self-block', async () => {
			const mock = makeMockClient();
			const r = await handler(
				makeCtx({
					signer: 'alice',
					payload: { blocked: 'alice', action: 'block' }
				}),
				mock.client
			);
			expect(r).toEqual({ ok: false, reason: 'self_block' });
			expect(mock.queries).toHaveLength(0);
		});

		it('rejects invalid action', async () => {
			const mock = makeMockClient();
			for (const bad of ['BLOCK', 'delete', '', 1, null, true]) {
				const r = await handler(
					makeCtx({
						signer: 'alice',
						payload: { blocked: 'bob', action: bad as unknown }
					}),
					mock.client
				);
				expect(r).toEqual({ ok: false, reason: 'action_invalid' });
			}
		});

		it('rejects missing blocked field', async () => {
			const mock = makeMockClient();
			const r = await handler(
				makeCtx({
					signer: 'alice',
					payload: { action: 'block' }
				}),
				mock.client
			);
			expect(r).toEqual({ ok: false, reason: 'blocked_invalid' });
		});
	});

	describe('fresh block', () => {
		it('inserts a row with both since_* and last_action_* anchored to this op', async () => {
			const mock = makeMockClient([
				{ match: 'SELECT state FROM blocks', rows: [] },
				{ match: 'INSERT INTO blocks' }
			]);
			const ctx = makeCtx({
				signer: 'alice',
				payload: { blocked: 'bob', action: 'block' },
				blockNum: 12345
			});
			const r = await handler(ctx, mock.client);
			expect(r).toEqual({ ok: true });
			// Confirm the INSERT included 'blocked' state + the
			// block anchor values.
			const insertQuery = mock.queries[1]!;
			expect(insertQuery.text).toContain("'blocked'");
			expect(insertQuery.params).toContain('alice');
			expect(insertQuery.params).toContain('bob');
			expect(insertQuery.params).toContain(12345);
		});
	});

	describe('fresh unblock (no prior row)', () => {
		it('rejects with no_prior_block', async () => {
			const mock = makeMockClient([{ match: 'SELECT state FROM blocks', rows: [] }]);
			const r = await handler(
				makeCtx({
					signer: 'alice',
					payload: { blocked: 'bob', action: 'unblock' }
				}),
				mock.client
			);
			expect(r).toEqual({ ok: false, reason: 'no_prior_block' });
			// SELECT ran; INSERT did not.
			expect(mock.queries).toHaveLength(1);
		});
	});

	describe('idempotent re-block', () => {
		it('accepts silently with no DB mutation when already blocked', async () => {
			const mock = makeMockClient([
				{ match: 'SELECT state FROM blocks', rows: [{ state: 'blocked' }] }
			]);
			const r = await handler(
				makeCtx({
					signer: 'alice',
					payload: { blocked: 'bob', action: 'block' }
				}),
				mock.client
			);
			expect(r).toEqual({ ok: true });
			// Only the SELECT ran — no INSERT / UPDATE.
			expect(mock.queries).toHaveLength(1);
		});
	});

	describe('idempotent re-unblock', () => {
		it('accepts silently with no DB mutation when already unblocked', async () => {
			const mock = makeMockClient([
				{ match: 'SELECT state FROM blocks', rows: [{ state: 'unblocked' }] }
			]);
			const r = await handler(
				makeCtx({
					signer: 'alice',
					payload: { blocked: 'bob', action: 'unblock' }
				}),
				mock.client
			);
			expect(r).toEqual({ ok: true });
			expect(mock.queries).toHaveLength(1);
		});
	});

	describe('block-after-unblock', () => {
		it('rewinds since_* to this op (new relationship)', async () => {
			const mock = makeMockClient([
				{ match: 'SELECT state FROM blocks', rows: [{ state: 'unblocked' }] },
				{ match: 'UPDATE blocks' }
			]);
			const ctx = makeCtx({
				signer: 'alice',
				payload: { blocked: 'bob', action: 'block' },
				blockNum: 67890
			});
			const r = await handler(ctx, mock.client);
			expect(r).toEqual({ ok: true });
			// UPDATE statement should set since_block_num to the new op's block.
			const updateQuery = mock.queries[1]!;
			expect(updateQuery.text).toContain("state = 'blocked'");
			expect(updateQuery.text).toContain('since_block_num');
			expect(updateQuery.params).toContain(67890);
		});
	});

	describe('unblock-after-block', () => {
		it('flips state but preserves since_*', async () => {
			const mock = makeMockClient([
				{ match: 'SELECT state FROM blocks', rows: [{ state: 'blocked' }] },
				{ match: 'UPDATE blocks' }
			]);
			const ctx = makeCtx({
				signer: 'alice',
				payload: { blocked: 'bob', action: 'unblock' },
				blockNum: 67890
			});
			const r = await handler(ctx, mock.client);
			expect(r).toEqual({ ok: true });
			const updateQuery = mock.queries[1]!;
			expect(updateQuery.text).toContain("state = 'unblocked'");
			// since_* should NOT be in the UPDATE SET clause — the
			// original anchor stays valid as audit trail.
			expect(updateQuery.text).not.toContain('since_block_num =');
			expect(updateQuery.text).not.toContain('since_trx_id =');
			// But last_action_block_num SHOULD move.
			expect(updateQuery.text).toContain('last_action_block_num');
		});
	});

	describe('account name validity boundary', () => {
		it('accepts 3-char account (min valid length)', async () => {
			const mock = makeMockClient([
				{ match: 'SELECT state FROM blocks', rows: [] },
				{ match: 'INSERT INTO blocks' }
			]);
			const r = await handler(
				makeCtx({
					signer: 'alice',
					payload: { blocked: 'bob', action: 'block' }
				}),
				mock.client
			);
			expect(r).toEqual({ ok: true });
		});

		it('accepts 16-char account (max valid length)', async () => {
			const mock = makeMockClient([
				{ match: 'SELECT state FROM blocks', rows: [] },
				{ match: 'INSERT INTO blocks' }
			]);
			const r = await handler(
				makeCtx({
					signer: 'alice',
					payload: { blocked: 'abcdefghijklmnop', action: 'block' }
				}),
				mock.client
			);
			expect(r).toEqual({ ok: true });
		});

		it('accepts account names with dots and hyphens', async () => {
			const mock = makeMockClient([
				{ match: 'SELECT state FROM blocks', rows: [] },
				{ match: 'INSERT INTO blocks' }
			]);
			const r = await handler(
				makeCtx({
					signer: 'alice',
					payload: { blocked: 'bob.v-2', action: 'block' }
				}),
				mock.client
			);
			expect(r).toEqual({ ok: true });
		});
	});
});
