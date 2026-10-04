/**
 * Heal for installed nodes: release and rpc-directory ops stored before their
 * signature was checked are re-judged once each, from a block independent RPC
 * operators agree on (officialOpReverify.ts).
 *
 *   - a release a hostile node made up (not in the agreed block) stops being
 *     valid, so it can no longer be the treasury pin;
 *   - a forged stored directory is deleted;
 *   - a genuine release this node lost to an RPC blip at apply time
 *     (`handler_threw`) is recorded valid;
 *   - no quorum → nothing changes, and it is tried again; a re-judged op is
 *     never read again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { fakeConfig } from '../testutils/context';
import { OfficialOpReverifier, blockContentKey } from '../../src/indexer/officialOpReverify';
import { transactionIdOf } from '../../src/blurt/snapshotOpTrust';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');
const CHAIN_ID = 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f';
const OFFICIAL = PrivateKey.fromSeed('official-op-reverify-official');
const CFG = fakeConfig({
	officialAccountName: 'morphit',
	officialPostingPubkey: OFFICIAL.createPublic().toString(),
	chainId: CHAIN_ID
});

const release = (version: string) => ({
	version,
	hash_manifest: { '/index.html': 'sha256-' + 'a'.repeat(43) + '=' }
});

function signedTrx(id: string, json: unknown, seq: number): Record<string, unknown> {
	return cryptoUtils.signTransaction(
		{
			ref_block_num: seq,
			ref_block_prefix: 2,
			expiration: '2026-10-01T12:01:00',
			operations: [
				[
					'custom_json',
					{
						required_auths: [],
						required_posting_auths: ['morphit'],
						id,
						json: JSON.stringify(json)
					}
				]
			],
			extensions: []
		} as never,
		[OFFICIAL],
		Buffer.from(CHAIN_ID, 'hex')
	) as unknown as Record<string, unknown>;
}

/** The chain as operators (counted by node name) agree on it: block number → block. */
function agreedChain(blocks: Map<number, unknown>, reads: number[]) {
	let reachable = true;
	return {
		setReachable(v: boolean) {
			reachable = v;
		},
		trustedQuorumSize: () => 2,
		mergeRpcEndpoints: () => [],
		condenserAgreed: async (
			_m: string,
			params: readonly unknown[],
			keyOf: (b: unknown) => string | null
		) => {
			const n = Number(params[0]);
			reads.push(n);
			if (!reachable) return null;
			const b = blocks.get(n);
			if (b === undefined) return null;
			const key = keyOf(b);
			return key === null ? null : { value: b, key };
		}
	};
}

async function storeOp(
	fx: IntegrationFixture,
	n: number,
	trxId: string,
	opId: string,
	payload: unknown,
	status: string,
	reason: string | null
): Promise<void> {
	await fx.db.query(
		`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status, reject_reason)
		 VALUES ($1, 0, 0, '2026-10-01T12:00:00Z', $2, 'morphit', $3, $4::jsonb, $5, $6)`,
		[n, trxId, opId, JSON.stringify(payload), status, reason]
	);
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'stored official ops are re-judged by their signature',
	() => {
		let fx: IntegrationFixture;
		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => {
			await fx?.teardown();
		});
		beforeEach(async () => {
			await truncateAll(fx);
			await fx.db.query('DELETE FROM rpc_directory');
			await fx.db.query('DELETE FROM fee_reverify_done');
		});

		it('a made-up release stops being valid; a lost genuine one is recorded; a forged directory goes', async () => {
			// Block 50: the forged release a hostile node served. The chain's block 50
			// holds no such transaction.
			await storeOp(
				fx,
				50,
				'f'.repeat(40),
				'morphit_release_v1',
				release('6.6.6'),
				'applied',
				null
			);
			await fx.db.query(
				`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num, source_trx_id, signer, valid, created_at)
			 VALUES ('6.6.6', '{}', '{}', '', 50, $1, 'morphit', true, now())`,
				['f'.repeat(40)]
			);
			// Block 60: a genuine signed release this node lost to an RPC blip.
			const genuine = signedTrx('morphit_release_v1', release('1.20.4'), 60);
			const genuineId = transactionIdOf(genuine)!;
			await storeOp(
				fx,
				60,
				genuineId,
				'morphit_release_v1',
				release('1.20.4'),
				'rejected',
				'handler_threw:all RPC endpoints failed'
			);
			// Block 70: a forged directory stored as the latest.
			await storeOp(fx, 70, 'e'.repeat(40), 'morphit_rpc_v1', { v: 1 }, 'applied', null);
			await fx.db.query(
				`INSERT INTO rpc_directory (id, endpoints, node_count, published_ts, block_num, node_names)
			 VALUES (1, ARRAY['http://${'a'.repeat(56)}.onion:8091'], 1, '2026-10-01T12:00:00Z', 70, '{}')`
			);

			const blocks = new Map<number, unknown>([
				[50, { block_id: 'b50', transactions: [] }],
				[60, { block_id: 'b60', transactions: [genuine] }],
				[70, { block_id: 'b70', transactions: [] }]
			]);
			const reads: number[] = [];
			const r = new OfficialOpReverifier({
				db: fx.db,
				blurt: agreedChain(blocks, reads) as never,
				config: CFG
			});
			const s = await r.runOnce();
			expect(s).toMatchObject({ checked: 3, unreachable: 0, backlog: false });

			const rel = await fx.db.query<{ version: string; valid: boolean }>(
				'SELECT version, valid FROM releases ORDER BY source_block_num'
			);
			expect(rel.rows).toEqual([
				{ version: '6.6.6', valid: false },
				{ version: '1.20.4', valid: true }
			]);
			const ops = await fx.db.query<{
				block_num: string;
				status: string;
				reject_reason: string | null;
			}>('SELECT block_num::text, status, reject_reason FROM ops ORDER BY block_num');
			expect(ops.rows).toEqual([
				{ block_num: '50', status: 'rejected', reject_reason: 'not_on_chain' },
				{ block_num: '60', status: 'applied', reject_reason: null },
				{ block_num: '70', status: 'rejected', reject_reason: 'not_on_chain' }
			]);
			expect((await fx.db.query('SELECT 1 FROM rpc_directory')).rowCount).toBe(0);

			// Judged once: a second pass reads nothing.
			reads.length = 0;
			expect((await r.runOnce()).checked).toBe(0);
			expect(reads).toEqual([]);
		});

		it('without a quorum nothing changes, and the op is tried again later', async () => {
			await storeOp(
				fx,
				80,
				'd'.repeat(40),
				'morphit_release_v1',
				release('7.7.7'),
				'applied',
				null
			);
			await fx.db.query(
				`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num, source_trx_id, signer, valid, created_at)
			 VALUES ('7.7.7', '{}', '{}', '', 80, $1, 'morphit', true, now())`,
				['d'.repeat(40)]
			);
			const reads: number[] = [];
			const chain = agreedChain(new Map([[80, { block_id: 'b80', transactions: [] }]]), reads);
			chain.setReachable(false);
			const r = new OfficialOpReverifier({ db: fx.db, blurt: chain as never, config: CFG });
			expect(await r.runOnce()).toMatchObject({ checked: 0, unreachable: 1, backlog: true });
			expect((await fx.db.query('SELECT valid FROM releases')).rows).toEqual([{ valid: true }]);
			chain.setReachable(true);
			expect(await r.runOnce()).toMatchObject({ checked: 1, changed: 1 });
			expect((await fx.db.query('SELECT valid FROM releases')).rows).toEqual([{ valid: false }]);
		});

		it('agrees on a block by the recomputed id of every transaction', () => {
			const t = signedTrx('morphit_rpc_v1', { v: 1 }, 9);
			const altered = {
				...t,
				operations: [
					['custom_json', { id: 'morphit_rpc_v1', required_posting_auths: ['morphit'], json: '{}' }]
				]
			};
			expect(blockContentKey({ block_id: 'x', transactions: [t] })).not.toBe(
				blockContentKey({ block_id: 'x', transactions: [altered] })
			);
			expect(blockContentKey({ block_id: 'x' })).toBeNull();
		});
	}
);
