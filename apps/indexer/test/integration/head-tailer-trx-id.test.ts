/**
 * VT1-9 — the head tailer's dedupe keys on the transaction's CONTENT, not on
 * the id the RPC node lists for it.
 *
 * A head block is one node's word, including its `transaction_ids`. Within a
 * signed transaction's expiry window a node could re-serve a chat message this
 * instance already stored (or already delivered on the fast path) under an id
 * of its choosing, and it was shown live again. The tailer now recomputes each
 * transaction's id from its content and uses only that.
 *
 * Real Postgres, real head tailer, real signatures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { _resetSeenForTest, _resetKeyRefreshForTest } from '../../src/indexer/chatFastFederation';
import { HeadTailer } from '../../src/indexer/headTailer';
import { chatEventBus } from '../../src/indexer/chatEventBus';
import { orderbookEventBus } from '../../src/indexer/orderbookEventBus';
import { markFastEmitted, _resetFastEmitLedgerForTest } from '../../src/indexer/fastEmitLedger';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const real = PrivateKey.fromSeed('e1-alice-real');
const attacker = PrivateKey.fromSeed('e1-attacker');
const realPub = real.createPublic().toString();
const attackerPub = attacker.createPublic().toString();

let seq = 0;
function chatOp(sender: string): [string, unknown] {
	return [
		'custom_json',
		{
			required_auths: [],
			required_posting_auths: [sender],
			id: 'morphit_chat_v1',
			json: JSON.stringify({
				recipient: 'bob',
				ciphertext: Buffer.from('hi').toString('base64'),
				header: { client_tag: `e1-${++seq}`, ephemeral_pub: 'AAAA', nonce: 'AAAA' }
			})
		}
	];
}
function unsignedTrx(op: [string, unknown]) {
	return {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
		operations: [op],
		extensions: [],
		signatures: [] as string[]
	};
}
function signedTrx(op: [string, unknown], key: typeof real) {
	return cryptoUtils.signTransaction(unsignedTrx(op) as never, [key]) as unknown as ReturnType<
		typeof unsignedTrx
	>;
}
function block(trxs: ReturnType<typeof unsignedTrx>[]) {
	return {
		timestamp: new Date().toISOString().slice(0, 19),
		transaction_ids: trxs.map((_, i) => `e1-trx-${seq}-${i}`),
		transactions: trxs
	};
}

describe.skipIf(!INTEGRATION_ENABLED)(
	'head tailer dedupe keys on transaction content (VT1-9)',
	() => {
		let fx: IntegrationFixture;
		async function tailerEmits(
			b: ReturnType<typeof block>
		): Promise<{ chat: string[]; orders: string[] }> {
			const chat: string[] = [];
			const orders: string[] = [];
			const offChat = chatEventBus.onFast((ev) => chat.push(ev.sender));
			const offOrders = orderbookEventBus.onProvisional((ev) => orders.push(ev.orderId));
			try {
				const tailer = new HeadTailer({} as never, fx.db, {} as never);
				await (tailer as unknown as { scanBlock(b: unknown): Promise<void> }).scanBlock(b);
			} finally {
				offChat();
				offOrders();
			}
			return { chat, orders };
		}

		beforeAll(async () => {
			fx = await setupWithMigrations();
		});
		afterAll(async () => {
			await fx?.teardown();
		});
		beforeEach(async () => {
			_resetSeenForTest();
			_resetKeyRefreshForTest();
			_resetFastEmitLedgerForTest();
			await fx.db.query('DELETE FROM chat_messages');
			await fx.db.query('DELETE FROM accounts');
			await fx.db.query(
				`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id,
			                       posting_pubkey, posting_key_reconciled)
			 VALUES ('alice','genesis',1,now(),'s1',$1,TRUE), ('bob','genesis',1,now(),'s2',NULL,TRUE)`,
				[realPub]
			);
		});

		it('a stored chat transaction re-served under another id is not shown live again', async () => {
			const trx = signedTrx(chatOp('alice'), real);
			const realId = cryptoUtils.generateTrxId(trx as never);
			await fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 VALUES ('alice', 'bob', 'x', '{}'::jsonb, now(), $1)`,
				[realId]
			);
			const honest = { ...block([trx]), transaction_ids: [realId] };
			const relabelled = { ...block([trx]), transaction_ids: ['f'.repeat(40)] };
			const a = (await tailerEmits(honest)).chat;
			const b = (await tailerEmits(relabelled)).chat;
			expect({ honest: a, relabelled: b }).toEqual({ honest: [], relabelled: [] });
		});

		it('a message already delivered on the fast path, re-served under another id, is not emitted twice', async () => {
			const trx = signedTrx(chatOp('alice'), real);
			markFastEmitted(cryptoUtils.generateTrxId(trx as never));
			const relabelled = { ...block([trx]), transaction_ids: ['e'.repeat(40)] };
			expect((await tailerEmits(relabelled)).chat).toEqual([]);
		});

		it('a new signed message is still shown live, whatever id the node lists for it', async () => {
			const trx = signedTrx(chatOp('alice'), real);
			const relabelled = { ...block([trx]), transaction_ids: ['d'.repeat(40)] };
			expect((await tailerEmits(relabelled)).chat).toEqual(['alice']);
		});
	}
);
