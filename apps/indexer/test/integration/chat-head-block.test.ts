/**
 * A block takes effect on the fast path at once (v1.21.14 full chat audit,
 * S-L2).
 *
 * The block list is written by the durable handler 45-63 s after the block op,
 * so a sender blocked a moment ago was still shown live and still notified by
 * every fast route. Now the head tailer recognises a signed block op as it
 * appears in a head block, and every fast route honours it.
 *
 * Real Postgres, the real head tailer and delivery route, real signatures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { HeadTailer, type LocatedChatOp } from '../../src/indexer/headTailer';
import { trxPostingSignatureState } from '../../src/indexer/chainTrxSignature';
import {
	headBlocked,
	headBlockPending,
	_resetHeadBlocksForTest
} from '../../src/indexer/headBlocks';
import { deliverVerifiedPush } from '../../src/indexer/chatFastFederation';
import { gatesFromDb } from '../../src/api/federationChatFast';
import { chatEventBus, type ChatFastEvent } from '../../src/indexer/chatEventBus';
import { _resetFastEmitLedgerForTest } from '../../src/indexer/fastEmitLedger';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const keys = {
	target: PrivateKey.fromSeed('hb-target'),
	pest: PrivateKey.fromSeed('hb-pest'),
	other: PrivateKey.fromSeed('hb-other')
};
const pub = (k: keyof typeof keys) => keys[k].createPublic().toString();

let seq = 0;
function signed(signer: keyof typeof keys, id: string, json: unknown, key = keys[signer]) {
	const trx = {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
		operations: [
			[
				'custom_json',
				{ required_auths: [], required_posting_auths: [signer], id, json: JSON.stringify(json) }
			]
		],
		extensions: [],
		signatures: [] as string[]
	};
	return cryptoUtils.signTransaction(trx as never, [key]) as unknown as typeof trx;
}
const blockOp = (action: 'block' | 'unblock', key = keys.target) =>
	signed('target', 'morphit_block_v1', { blocked: 'pest', action, n: ++seq }, key);
const chatOp = () =>
	signed('pest', 'morphit_chat_v1', {
		recipient: 'target',
		ciphertext: Buffer.from(`hi ${++seq}`).toString('base64'),
		header: { client_tag: `hb-${seq}`, ephemeral_pub: 'AAAA', nonce: 'AAAA' }
	});
const located = (tag: string): LocatedChatOp =>
	({
		signer: 'pest',
		recipient: 'target',
		ciphertext: 'AAAA',
		header: { client_tag: tag },
		clientTag: tag,
		orderPermlink: null
	}) as unknown as LocatedChatOp;

describe.skipIf(!INTEGRATION_ENABLED)('a block seen at the head', () => {
	let fx: IntegrationFixture;
	/** Accounts whose key this instance can check without the chain. */
	let unknownKeys = new Set<string>();
	/** Accounts whose key on file is an old one (rotated on chain, not yet here). */
	let staleKeys = new Set<string>();
	const lookup = async (account: string) =>
		staleKeys.has(account)
			? pub('other')
			: account in keys && !unknownKeys.has(account)
				? pub(account as keyof typeof keys)
				: null;
	const tailer = () =>
		new HeadTailer({} as never, fx.db, {} as never, {
			signerState: trxPostingSignatureState(lookup)
		});
	const scan = (t: HeadTailer, trxs: unknown[]) =>
		(t as unknown as { scanBlock(b: unknown): Promise<void> }).scanBlock({
			timestamp: new Date().toISOString().slice(0, 19),
			transaction_ids: trxs.map(() => 'x'),
			transactions: trxs
		});

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => fx?.teardown());
	afterEach(() => {
		vi.useRealTimers();
	});
	beforeEach(async () => {
		unknownKeys = new Set();
		staleKeys = new Set();
		_resetHeadBlocksForTest();
		_resetFastEmitLedgerForTest();
		for (const t of ['blocks', 'chat_messages']) await fx.db.query(`DELETE FROM ${t}`);
		// An established conversation, so nothing but the block holds the message.
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
			 VALUES ('target','pest','x','{}'::jsonb, NOW() - INTERVAL '1 day','t0')`
		);
	});

	const watching = async (fn: (events: ChatFastEvent[]) => Promise<void>) => {
		const events: ChatFastEvent[] = [];
		const off = chatEventBus.onFast((ev) => events.push(ev));
		try {
			await fn(events);
		} finally {
			off();
		}
	};

	it('control: without the block the message is shown', async () => {
		await watching(async (events) => {
			const t = tailer();
			await scan(t, [chatOp()]);
			expect(events.map((e) => e.sender)).toEqual(['pest']);
			t.stop();
		});
	});

	it('a message after a head-block block is not shown, on any fast route', async () => {
		await watching(async (events) => {
			const t = tailer();
			await scan(t, [blockOp('block')]);
			expect(headBlocked('target', 'pest')).toBe(true);
			await scan(t, [chatOp()]);
			expect(await deliverVerifiedPush(located('pushed'), 'trx-pushed', gatesFromDb(fx.db))).toBe(
				'blocked'
			);
			expect(events).toEqual([]);
			t.stop();
		});
	});

	it('a block and a message in the SAME head block: the message is held back', async () => {
		await watching(async (events) => {
			const t = tailer();
			await scan(t, [blockOp('block'), chatOp()]);
			expect(events).toEqual([]);
			t.stop();
		});
	});

	/** Run the tailer's recheck timers for `ms`, letting their real database
	 *  reads finish, until `done` holds. */
	// Fake time moves in 250 ms steps; between steps the database (real I/O) gets
	// up to 60 ms of REAL time to answer. Counting event-loop turns instead
	// (50) let fake time run past the key read's last look on a loaded machine,
	// before the read had answered: the test failed once in a full integration
	// run (v1.21.14 final review).
	const settle = async (ms: number, done: () => boolean) => {
		for (let elapsed = 0; elapsed < ms; elapsed += 250) {
			await vi.advanceTimersByTimeAsync(250);
			const until = performance.now() + 60;
			while (!done() && performance.now() < until) await new Promise((r) => setImmediate(r));
		}
	};

	it("a block op the blocker's key on file did not sign holds nothing back (review 2, finding 6)", async () => {
		await watching(async (events) => {
			const t = tailer();
			await scan(t, [blockOp('block', keys.other)]);
			expect(headBlockPending('target', 'pest')).toBe(false);
			expect(headBlocked('target', 'pest')).toBe(false);
			// The pair is not held: the message goes live at once, on every route.
			await scan(t, [chatOp()]);
			expect(events.map((e) => e.sender)).toEqual(['pest']);
			expect(await deliverVerifiedPush(located('pushed'), 'trx-pushed', gatesFromDb(fx.db))).toBe(
				'emitted'
			);
			t.stop();
		});
	});

	it('a block signed with a key rotated a moment ago is recorded once the key on file catches up', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		staleKeys.add('target');
		const t = tailer();
		await scan(t, [blockOp('block')]);
		// Not held meanwhile (the key on file did not sign it)…
		expect(headBlocked('target', 'pest')).toBe(false);
		// …but looked at again: the chain's key arrives, and the block counts.
		staleKeys.delete('target');
		await settle(20_000, () => headBlocked('target', 'pest'));
		expect(headBlocked('target', 'pest')).toBe(true);
		t.stop();
	});

	it("an unknown key that turns out not to be the blocker's: dropped after the last look, the held message then shown", async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		unknownKeys.add('target');
		await watching(async (events) => {
			const t = tailer();
			await scan(t, [blockOp('block', keys.other)]);
			// Held back while the signature is in doubt — stricter, never looser…
			expect(headBlockPending('target', 'pest')).toBe(true);
			await scan(t, [chatOp()]);
			expect(events).toEqual([]);
			// …the key arrives and is not the signer's: dropped, the message goes live.
			unknownKeys.delete('target');
			await settle(20_000, () => events.length > 0);
			expect(headBlocked('target', 'pest')).toBe(false);
			expect(events.map((e) => e.sender)).toEqual(['pest']);
			t.stop();
		});
	});

	it('a blocker whose key needs the chain: the block holds at once and is recorded once the key arrives (finding 7)', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		unknownKeys.add('target');
		await watching(async (events) => {
			const t = tailer();
			await scan(t, [blockOp('block')]);
			expect(headBlocked('target', 'pest')).toBe(true);
			await scan(t, [chatOp()]);
			expect(events).toEqual([]);
			// The background key read answers.
			unknownKeys.delete('target');
			await settle(20_000, () => false);
			expect(headBlockPending('target', 'pest')).toBe(false);
			expect(headBlocked('target', 'pest')).toBe(true);
			expect(events).toEqual([]);
			t.stop();
		});
	});

	it('an unblock at the head clears an earlier head block, and only that', async () => {
		const t = tailer();
		await scan(t, [blockOp('block')]);
		await scan(t, [blockOp('unblock')]);
		expect(headBlocked('target', 'pest')).toBe(false);
		// The durable list still decides: an unblock seen early never lets a
		// durably blocked sender through.
		await fx.db.query(
			`INSERT INTO blocks (blocker, blocked, state, since_block_num, since_trx_id,
			                     last_action_block_num, created_at, updated_at)
			 VALUES ('target','pest','blocked',1,'b0',1,NOW(),NOW())`
		);
		expect(await deliverVerifiedPush(located('later'), 'trx-later', gatesFromDb(fx.db))).toBe(
			'blocked'
		);
		t.stop();
	});

	it('review A, F7: a message EARLIER in the same head block than the block op is not shown either', async () => {
		// The durable path applies a block's block ops before its chat ops
		// (sortOpsForAdmission) and refuses the message; the tailer read them in
		// transaction order and announced it.
		await watching(async (events) => {
			const t = tailer();
			await scan(t, [chatOp(), blockOp('block')]);
			expect(events.map((e) => e.sender)).toEqual([]);
			t.stop();
		});
	});

	/** One transaction from `other` blocking `n` made-up accounts. */
	function massBlocks(n: number, from: number) {
		const ops = [];
		for (let i = 0; i < n; i++)
			ops.push([
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: ['other'],
					id: 'morphit_block_v1',
					json: JSON.stringify({ blocked: `zz${from + i}`, action: 'block' })
				}
			]);
		const trx = {
			ref_block_num: 1,
			ref_block_prefix: 2,
			expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
			operations: ops,
			extensions: [],
			signatures: [] as string[]
		};
		return cryptoUtils.signTransaction(trx as never, [keys.other]) as unknown as typeof trx;
	}

	it("review A, F6: one account blocking thousands at the head cannot push out another user's block", async () => {
		const t = tailer();
		await scan(t, [blockOp('block')]);
		expect(headBlocked('target', 'pest')).toBe(true);
		for (let k = 0; k < 13; k++) await scan(t, [massBlocks(400, k * 400)]);
		expect(headBlocked('target', 'pest')).toBe(true);
		t.stop();
	}, 120_000);

	it('review A, F6: a transaction of many block ops checks its signature once per account, not once per op', async () => {
		let checks = 0;
		const state = trxPostingSignatureState(lookup);
		const t = new HeadTailer({} as never, fx.db, {} as never, {
			signerState: async (trx, account) => {
				checks++;
				return state(trx, account);
			}
		});
		await scan(t, [massBlocks(100, 90_000)]);
		expect(checks).toBeLessThanOrEqual(1);
		t.stop();
	});
});
