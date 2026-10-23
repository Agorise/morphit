/**
 * A paid first contact reaches the inbox fast (v1.21.14 full chat audit, S-H3).
 *
 * The durable handler records a stranger fee only once its block is
 * irreversible, 45-63 s after the payment. Until then the fast notify gate had
 * nothing to go on, so the paid "new chatroom request" — the message the fee
 * exists to let through — was not announced, not pushed and not replayed. Now
 * the head tailer recognises the fee as it appears in a head block (ACTIVE
 * signature by keys two operators agree on, plus the durable handler's own
 * checks), and a message that reached this instance before its fee is
 * announced the moment the fee is recognised.
 *
 * Real Postgres, the real head tailer, the real gate, the real enqueue, the
 * real delivery route, real signatures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { HeadTailer, type LocatedChatOp } from '../../src/indexer/headTailer';
import { trxSignedByActiveAuthority } from '../../src/indexer/chainTrxSignature';
import { fastChatNotifyAllowed } from '../../src/indexer/fastNotifyGate';
import {
	hasHeadStrangerFee,
	_resetHeadStrangerFeesForTest
} from '../../src/indexer/headStrangerFees';
import {
	parkFirstContact,
	releaseFirstContacts,
	parkedFirstContactsStatus,
	_resetParkedFirstContactsForTest
} from '../../src/indexer/parkedFirstContacts';
import { deliverVerifiedPush } from '../../src/indexer/chatFastFederation';
import { gatesFromDb } from '../../src/api/federationChatFast';
import { chatEventBus, type ChatFastEvent } from '../../src/indexer/chatEventBus';
import { _resetFastEmitLedgerForTest } from '../../src/indexer/fastEmitLedger';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const active = PrivateKey.fromSeed('hsf-payer-active');
const posting = PrivateKey.fromSeed('hsf-payer-posting');
const activePub = active.createPublic().toString();

/** The chain, as two agreeing operators would answer it. */
let chainReads = 0;
let quorumAgrees = true;
const reader = {
	async getAccountsAgreed(names: readonly string[]) {
		chainReads++;
		if (!quorumAgrees) return null;
		const m = new Map();
		for (const n of names)
			if (n === 'payer') m.set(n, { active: { weight_threshold: 1, key_auths: [[activePub, 1]] } });
		return m;
	}
};

const config = { feeRecipient: 'morphit-fees', feeTolerance: 0.05 } as never;

let seq = 0;
function feeTrx(
	opts: {
		key?: typeof active;
		memoFor?: string;
		amount?: string;
		recipient?: string;
		quoted?: number;
	} = {}
) {
	const recipient = opts.recipient ?? 'target';
	const trx = {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
		operations: [
			[
				'transfer',
				{
					from: 'payer',
					to: 'morphit-fees',
					amount: opts.amount ?? '5.000 BLURT',
					memo: `morphit-stranger:${opts.memoFor ?? recipient}`
				}
			],
			[
				'custom_json',
				{
					required_auths: ['payer'],
					required_posting_auths: [],
					id: 'morphit_stranger_fee_v1',
					json: JSON.stringify({ v: 1, recipient, amount_blurt: opts.quoted ?? 5, n: ++seq })
				}
			]
		],
		extensions: [],
		signatures: [] as string[]
	};
	return cryptoUtils.signTransaction(trx as never, [opts.key ?? active]) as unknown as typeof trx;
}

const block = (trx: unknown) => ({
	timestamp: new Date().toISOString().slice(0, 19),
	transaction_ids: ['x'],
	transactions: [trx]
});

function firstContact(tag: string): LocatedChatOp {
	return {
		signer: 'payer',
		recipient: 'target',
		ciphertext: 'AAAA',
		header: { client_tag: tag },
		clientTag: tag,
		orderPermlink: null
	} as unknown as LocatedChatOp;
}

describe.skipIf(!INTEGRATION_ENABLED)('stranger fee seen at the head', () => {
	let fx: IntegrationFixture;
	const scan = (tailer: HeadTailer, trx: unknown) =>
		(tailer as unknown as { scanBlock(b: unknown, n: number): Promise<void> }).scanBlock(
			block(trx),
			1000
		);
	const pushes = async (): Promise<number> =>
		Number(
			(
				await fx.db.query<{ n: number }>(
					`SELECT COUNT(*)::int AS n FROM push_pending WHERE account = 'target'`
				)
			).rows[0]?.n
		);

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => fx?.teardown());
	beforeEach(async () => {
		_resetHeadStrangerFeesForTest();
		_resetParkedFirstContactsForTest();
		_resetFastEmitLedgerForTest();
		chainReads = 0;
		quorumAgrees = true;
		for (const t of [
			'push_pending',
			'push_subscriptions',
			'stranger_fees',
			'chat_messages',
			'blocks'
		])
			await fx.db.query(`DELETE FROM ${t}`);
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode, locale)
			 VALUES ('target','https://example.invalid/t','p','a','standard','en')`
		);
	});

	const tailerWith = (withActive = true) =>
		new HeadTailer(config, fx.db, {} as never, {
			signedBySigner: async () => true,
			...(withActive ? { signedByActive: trxSignedByActiveAuthority(reader) } : {})
		});

	it('a valid fee in a head block lets the first contact through the fast gate', async () => {
		const tailer = tailerWith();
		expect(await fastChatNotifyAllowed(fx.db, firstContact('a'), new Date())).toBe(false);
		await scan(tailer, feeTrx());
		await vi.waitFor(() => expect(hasHeadStrangerFee('payer', 'target')).toBe(true));
		expect(await fastChatNotifyAllowed(fx.db, firstContact('a'), new Date())).toBe(true);
		// Only for that recipient, and only for that payer.
		expect(hasHeadStrangerFee('payer', 'someone')).toBe(false);
		expect(hasHeadStrangerFee('other', 'target')).toBe(false);
		tailer.stop();
	});

	const refused: [string, () => unknown][] = [
		['signed by the posting key, not the active key', () => feeTrx({ key: posting })],
		['whose transfer names another recipient', () => feeTrx({ memoFor: 'someone' })],
		['that pays less than the quote', () => feeTrx({ amount: '1.000 BLURT' })]
	];
	for (const [what, make] of refused) {
		it(`a fee ${what} is not recognised`, async () => {
			const tailer = tailerWith();
			await scan(tailer, make());
			// Let every background step finish.
			for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 10));
			expect(hasHeadStrangerFee('payer', 'target')).toBe(false);
			expect(await fastChatNotifyAllowed(fx.db, firstContact('b'), new Date())).toBe(false);
			tailer.stop();
		});
	}

	it('without two agreeing operators the fee is not recognised', async () => {
		quorumAgrees = false;
		const tailer = tailerWith();
		await scan(tailer, feeTrx());
		await vi.waitFor(() => expect(chainReads).toBe(1));
		await new Promise((r) => setTimeout(r, 10));
		expect(hasHeadStrangerFee('payer', 'target')).toBe(false);
		tailer.stop();
	});

	it('a first contact that arrived before its fee is announced once the fee is recognised', async () => {
		const events: ChatFastEvent[] = [];
		const off = chatEventBus.onFast((ev) => events.push(ev));
		const tailer = tailerWith();
		try {
			// The message, pushed by the sender's instance, arrives first: shown
			// live, not announced, not pushed.
			expect(
				await deliverVerifiedPush(firstContact('early'), 'trx-early', gatesFromDb(fx.db))
			).toBe('emitted');
			expect(events.map((e) => e.replayable)).toEqual([false]);
			expect(await pushes()).toBe(0);
			expect(parkedFirstContactsStatus().parked).toBe(1);
			// Then its fee appears in a head block.
			await scan(tailer, feeTrx());
			await vi.waitFor(() => expect(events.map((e) => e.replayable)).toEqual([false, true]));
			await vi.waitFor(async () => expect(await pushes()).toBe(1));
			expect(events[1]?.clientTag).toBe('early');
			expect(parkedFirstContactsStatus()).toEqual({ parked: 0, released: 1 });
		} finally {
			off();
			tailer.stop();
		}
	});

	it('a parked message whose fee never comes is never announced', async () => {
		const events: ChatFastEvent[] = [];
		const off = chatEventBus.onFast((ev) => events.push(ev));
		const tailer = tailerWith();
		try {
			await deliverVerifiedPush(firstContact('unpaid'), 'trx-unpaid', gatesFromDb(fx.db));
			// A fee from the same payer for someone else.
			await scan(tailer, feeTrx({ recipient: 'someone' }));
			await vi.waitFor(() => expect(hasHeadStrangerFee('payer', 'someone')).toBe(true));
			await new Promise((r) => setTimeout(r, 10));
			expect(events.map((e) => e.replayable)).toEqual([false]);
			expect(await pushes()).toBe(0);
		} finally {
			off();
			tailer.stop();
		}
	});

	it('a released message is gated again: a tag naming no order stays unannounced after the fee', async () => {
		const events: ChatFastEvent[] = [];
		const off = chatEventBus.onFast((ev) => events.push(ev));
		const tailer = tailerWith();
		try {
			const bogus = { ...firstContact('bogus'), orderPermlink: 'no-such-order' } as LocatedChatOp;
			await deliverVerifiedPush(bogus, 'trx-bogus', gatesFromDb(fx.db));
			expect(parkedFirstContactsStatus().parked).toBe(1);
			await scan(tailer, feeTrx());
			await vi.waitFor(() => expect(parkedFirstContactsStatus().parked).toBe(0));
			await new Promise((r) => setTimeout(r, 10));
			expect(events.map((e) => e.replayable)).toEqual([false]);
			expect(await pushes()).toBe(0);
		} finally {
			off();
			tailer.stop();
		}
	});

	it('a message refused just before its fee was recognised is released at once', async () => {
		const tailer = tailerWith();
		await scan(tailer, feeTrx());
		await vi.waitFor(() => expect(hasHeadStrangerFee('payer', 'target')).toBe(true));
		const events: ChatFastEvent[] = [];
		const off = chatEventBus.onFast((ev) => events.push(ev));
		try {
			// The gate said no while the fee was still being checked.
			parkFirstContact({
				located: firstContact('raced'),
				trxId: 'trx-raced',
				createdAt: new Date(),
				gateAt: new Date(),
				blocked: async () => false,
				gate: (l, at) => fastChatNotifyAllowed(fx.db, l, at),
				notify: async () => undefined
			});
			await vi.waitFor(() =>
				expect(events.map((e) => [e.clientTag, e.replayable])).toEqual([['raced', true]])
			);
		} finally {
			off();
			tailer.stop();
		}
	});

	for (const route of ['federation push', 'head tailer'] as const) {
		it(`${route}: a first contact parked, then blocked by the recipient, is not announced when the fee comes (finding 10)`, async () => {
			const events: ChatFastEvent[] = [];
			const off = chatEventBus.onFast((ev) => events.push(ev));
			const tailer = tailerWith();
			try {
				if (route === 'federation push')
					await deliverVerifiedPush(firstContact('then-blocked'), 'trx-tb', gatesFromDb(fx.db));
				else
					(tailer as unknown as { park(l: LocatedChatOp, id: string, at: Date): void }).park(
						firstContact('then-blocked'),
						'trx-tb',
						new Date()
					);
				expect(parkedFirstContactsStatus().parked).toBe(1);
				await fx.db.query(
					`INSERT INTO blocks (blocker, blocked, state, since_block_num, since_trx_id,
					                     last_action_block_num, created_at, updated_at)
					 VALUES ('target','payer','blocked',1,'b0',1,NOW(),NOW())`
				);
				await scan(tailer, feeTrx());
				await vi.waitFor(() => expect(parkedFirstContactsStatus().parked).toBe(0));
				await new Promise((r) => setTimeout(r, 10));
				expect(events.filter((e) => e.replayable)).toEqual([]);
				expect(parkedFirstContactsStatus().released).toBe(0);
				expect(await pushes()).toBe(0);
			} finally {
				off();
				tailer.stop();
			}
		});
	}

	it('a parked message whose recipient blocked the sender meanwhile is not released (finding 10)', async () => {
		const events: ChatFastEvent[] = [];
		const off = chatEventBus.onFast((ev) => events.push(ev));
		const asked: string[] = [];
		let notified = 0;
		try {
			parkFirstContact({
				located: firstContact('blocked-meanwhile'),
				trxId: 'trx-blocked-meanwhile',
				createdAt: new Date(),
				gateAt: new Date(),
				blocked: async (l) => {
					asked.push(`${l.recipient}>${l.signer}`);
					return true;
				},
				gate: async () => true,
				notify: async () => {
					notified++;
				}
			});
			expect(await releaseFirstContacts('payer', 'target')).toBe(0);
			expect(asked).toEqual(['target>payer']);
			expect(events).toEqual([]);
			expect(notified).toBe(0);
		} finally {
			off();
		}
	});

	it('a second fee within the escalation window is priced like the durable handler prices it', async () => {
		const tailer = tailerWith();
		await scan(tailer, feeTrx({ recipient: 'target' }));
		await vi.waitFor(() => expect(hasHeadStrangerFee('payer', 'target')).toBe(true));
		// The first fee is not durable yet; the second one, at the base price,
		// would be refused by the durable handler (it costs double by then).
		await scan(tailer, feeTrx({ recipient: 'second' }));
		await vi.waitFor(() => expect(chainReads).toBe(1));
		await new Promise((r) => setTimeout(r, 10));
		expect(hasHeadStrangerFee('payer', 'second')).toBe(false);
		// Paying the escalated price, it is recognised.
		await scan(tailer, feeTrx({ recipient: 'third', amount: '10.000 BLURT', quoted: 10 }));
		await vi.waitFor(() => expect(hasHeadStrangerFee('payer', 'third')).toBe(true));
		tailer.stop();
	});

	it('a head tailer with no active-signature check recognises nothing', async () => {
		const tailer = tailerWith(false);
		await scan(tailer, feeTrx());
		await new Promise((r) => setTimeout(r, 10));
		expect(hasHeadStrangerFee('payer', 'target')).toBe(false);
		expect(chainReads).toBe(0);
		tailer.stop();
	});

	// ── v1.21.14 review A, F5 / F8 ─────────────────────────────────────────
	const scanAt = (tailer: HeadTailer, trx: unknown, n: number) =>
		(tailer as unknown as { scanBlock(b: unknown, n: number): Promise<void> }).scanBlock(
			block(trx),
			n
		);
	/** Every head stranger-fee check the tailer queued has finished. */
	const feeChecksDone = (tailer: HeadTailer): Promise<unknown> =>
		(tailer as unknown as { feeChain: Promise<unknown> }).feeChain;
	async function durableCursor(n: number): Promise<void> {
		await fx.db.query(
			`INSERT INTO indexer_state (id, last_applied_block, chain_id) VALUES (1, $1, 'test')
			 ON CONFLICT (id) DO UPDATE SET last_applied_block = EXCLUDED.last_applied_block`,
			[n]
		);
	}

	it('review A, F5a: a head fee that has since become durable is not counted twice', async () => {
		await durableCursor(990);
		const tailer = tailerWith();
		await scanAt(tailer, feeTrx({ recipient: 'target' }), 1000);
		await vi.waitFor(() => expect(hasHeadStrangerFee('payer', 'target')).toBe(true));
		// The durable path stores it, and moves past its block.
		await fx.db.query(
			`INSERT INTO stranger_fees (sender, recipient, paid_block_num, paid_trx_id, paid_at, amount_blurt)
			 VALUES ('payer','target',1000,'${'f'.repeat(40)}',NOW() - INTERVAL '1 minute',5)`
		);
		await durableCursor(1000);
		// The second fee pays the escalated price (one fee in the window): 10.
		await scanAt(tailer, feeTrx({ recipient: 'second', amount: '10.000 BLURT', quoted: 10 }), 1010);
		await vi.waitFor(() => expect(hasHeadStrangerFee('payer', 'second')).toBe(true), {
			timeout: 2000
		});
		tailer.stop();
	});

	it('review A, F5b: after a restart, a fee is not recognised while blocks between the durable cursor and the tailer are unseen', async () => {
		await durableCursor(990);
		// A fee in block 1000 the durable path has not reached, and this tailer
		// (started at 1005) never saw. The next one, at the base price, is one
		// the durable handler will refuse.
		const tailer = tailerWith();
		(tailer as unknown as { coveredFrom: number }).coveredFrom = 1005;
		await scanAt(tailer, feeTrx({ recipient: 'second' }), 1006);
		await feeChecksDone(tailer);
		expect(hasHeadStrangerFee('payer', 'second')).toBe(false);
		// Once the durable path has caught up to where the tailer started, fees are recognised again.
		await durableCursor(1004);
		await scanAt(tailer, feeTrx({ recipient: 'third' }), 1007);
		await vi.waitFor(() => expect(hasHeadStrangerFee('payer', 'third')).toBe(true));
		tailer.stop();
	});

	it('review A, F8: fee-shaped ops in one head transaction are checked a few at a time, and only with a fee transfer', async () => {
		let inFlight = 0;
		let most = 0;
		let queries = 0;
		const db = {
			query: async (...a: unknown[]) => {
				queries++;
				inFlight++;
				most = Math.max(most, inFlight);
				try {
					return await (fx.db.query as (...x: unknown[]) => Promise<unknown>)(...a);
				} finally {
					inFlight--;
				}
			}
		};
		const tailer = new HeadTailer(config, db as never, {} as never, {
			signedBySigner: async () => true,
			signedByActive: trxSignedByActiveAuthority(reader)
		});
		// One fee transfer in the transaction, so every op gets past the cheap
		// check and the queue is what bounds the reads.
		const ops: unknown[] = [
			[
				'transfer',
				{ from: 'payer', to: 'morphit-fees', amount: '5.000 BLURT', memo: 'morphit-stranger:r0' }
			]
		];
		for (let i = 0; i < 400; i++)
			ops.push([
				'custom_json',
				{
					required_auths: ['payer'],
					required_posting_auths: [],
					id: 'morphit_stranger_fee_v1',
					json: JSON.stringify({ v: 1, recipient: `r${i}`, amount_blurt: 5 })
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
		const signedTrx = cryptoUtils.signTransaction(trx as never, [active]);
		await scanAt(tailer, signedTrx, 2000);
		await feeChecksDone(tailer);
		expect(most, 'database queries in flight at once').toBeLessThanOrEqual(4);
		tailer.stop();
	});

	it('review A, F8: fee-shaped ops with no fee transfer cost no database read at all', async () => {
		let queries = 0;
		const db = {
			query: async (...a: unknown[]) => {
				queries++;
				return await (fx.db.query as (...x: unknown[]) => Promise<unknown>)(...a);
			}
		};
		const tailer = new HeadTailer(config, db as never, {} as never, {
			signedBySigner: async () => true,
			signedByActive: trxSignedByActiveAuthority(reader)
		});
		const ops = [];
		for (let i = 0; i < 50; i++)
			ops.push([
				'custom_json',
				{
					required_auths: ['payer'],
					required_posting_auths: [],
					id: 'morphit_stranger_fee_v1',
					json: JSON.stringify({ v: 1, recipient: `q${i}`, amount_blurt: 5 })
				}
			]);
		const trx = cryptoUtils.signTransaction(
			{
				ref_block_num: 1,
				ref_block_prefix: 2,
				expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
				operations: ops,
				extensions: [],
				signatures: []
			} as never,
			[active]
		);
		await scanAt(tailer, trx, 2100);
		await feeChecksDone(tailer);
		expect(queries).toBe(0);
		tailer.stop();
	});
});
