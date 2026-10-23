/**
 * Who is notified, and how fast (v1.21.14 full chat audit).
 *
 *   - S-H3: a first contact whose sender PAID the stranger fee (or already has
 *     an admitted message to the recipient) is admitted by the durable handler,
 *     but the fast gate had no branch for it: no push, no inbox ping, no replay
 *     until the durable path, 45-63 s later.
 *   - S-M1: a seller who had just replied to a buyer through this instance got
 *     no notification for the buyer's next message: the push cap's "has the
 *     recipient replied?" read only the durable table.
 *   - S-M2: the push cap matched an earlier push by `LIKE '%/chat/<sender>%'`,
 *     so a push from "bobby" silenced the first message from "bob".
 *   - S-M3: the one-push-per-day-until-reply cap read earlier pushes from their
 *     tombstones, which the relay pruned after an hour.
 *
 * Real Postgres, the real gate, the real enqueue, the relay's real janitor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { enqueueChatPush } from '../../src/indexer/chatPushEnqueue';
import {
	fastChatNotifyAllowed,
	_resetFastNotifyGateForTest
} from '../../src/indexer/fastNotifyGate';
import { noteOutboundChat, _resetOutboundChatForTest } from '../../src/indexer/recentOutboundChat';
import { HeadTailer, type LocatedChatOp } from '../../src/indexer/headTailer';
import { prunePushTombstones } from '../../../relay/src/policy/pushQueueJanitor.ts';

function msg(
	signer: string,
	recipient: string,
	orderPermlink: string | null = null,
	tag = 'x'
): LocatedChatOp {
	return {
		signer,
		recipient,
		ciphertext: 'AAAA',
		header: { client_tag: tag },
		clientTag: tag,
		orderPermlink
	} as unknown as LocatedChatOp;
}

describe.skipIf(!INTEGRATION_ENABLED)('chat notification gates (full chat audit)', () => {
	let fx: IntegrationFixture;
	const pushes = async (account: string, unsentOnly = false): Promise<number> =>
		Number(
			(
				await fx.db.query<{ n: number }>(
					`SELECT COUNT(*)::int AS n FROM push_pending WHERE account = $1 ${unsentOnly ? 'AND sent_at IS NULL' : ''}`,
					[account]
				)
			).rows[0]?.n
		);
	const push = (recipient: string, sender: string, trx: string, at = new Date()) =>
		enqueueChatPush(fx.db, {
			recipient,
			sender,
			orderPermlink: null,
			sourceTrxId: trx,
			eventAt: at
		});

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => fx?.teardown());
	beforeEach(async () => {
		_resetOutboundChatForTest();
		_resetFastNotifyGateForTest();
		for (const t of ['push_pending', 'push_subscriptions', 'stranger_fees', 'chat_messages'])
			await fx.db.query(`DELETE FROM ${t}`);
		await fx.db.query(
			`INSERT INTO push_subscriptions (account, endpoint, p256dh, auth, privacy_mode, locale)
			 VALUES ('seller','https://example.invalid/s','p','a','standard','en'),
			        ('alice','https://example.invalid/a','p','a','standard','en'),
			        ('target','https://example.invalid/t','p','a','standard','en')`
		);
	});

	it('S-H3: a first contact whose sender paid the stranger fee passes the fast gate', async () => {
		expect(await fastChatNotifyAllowed(fx.db, msg('payer', 'target'), new Date())).toBe(false);
		await fx.db.query(
			`INSERT INTO stranger_fees (sender, recipient, paid_block_num, paid_trx_id, paid_at, amount_blurt)
			 VALUES ('payer','target',1,'feetrx',NOW(),10)`
		);
		expect(await fastChatNotifyAllowed(fx.db, msg('payer', 'target'), new Date())).toBe(true);
	});

	it('S-H3: a sender with an earlier admitted message passes the fast gate', async () => {
		await fx.db.query(
			`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
			 VALUES ('payer','target','x','{}'::jsonb, NOW() - INTERVAL '1 hour','t0')`
		);
		expect(await fastChatNotifyAllowed(fx.db, msg('payer', 'target'), new Date())).toBe(true);
	});

	it('S-H3: a paid fee for another recipient does not let a stranger through', async () => {
		await fx.db.query(
			`INSERT INTO stranger_fees (sender, recipient, paid_block_num, paid_trx_id, paid_at, amount_blurt)
			 VALUES ('payer','someone-else',1,'feetrx',NOW(),10)`
		);
		expect(await fastChatNotifyAllowed(fx.db, msg('payer', 'target'), new Date())).toBe(false);
	});

	describe('the durable no-reply caps (independent review, finding 2)', () => {
		let seq = 0;
		const fee = (sender: string, recipient: string) =>
			fx.db.query(
				`INSERT INTO stranger_fees (sender, recipient, paid_block_num, paid_trx_id, paid_at, amount_blurt)
				 VALUES ($1, $2, 1, $3, NOW(), 5)`,
				[sender, recipient, `fee${++seq}`]
			);
		const stored = (sender: string, recipient: string, n: number) =>
			fx.db.query(
				`INSERT INTO chat_messages (sender, recipient, ciphertext, header, created_at, source_trx_id)
				 SELECT $1, $2, 'x', '{}'::jsonb, NOW() - INTERVAL '1 hour', $3 || g::text
				   FROM generate_series(1, $4::int) g`,
				[sender, recipient, `m${++seq}-`, n]
			);

		it('a paying sender with 50 unanswered messages is not announced for the 51st', async () => {
			await fee('payer', 'target');
			await stored('payer', 'target', 49);
			expect(await fastChatNotifyAllowed(fx.db, msg('payer', 'target'), new Date())).toBe(true);
			await stored('payer', 'target', 1);
			expect(await fastChatNotifyAllowed(fx.db, msg('payer', 'target'), new Date())).toBe(false);
		});

		it('a burst cannot outrun the durable count: announced messages count until stored', async () => {
			await fee('payer', 'target');
			await stored('payer', 'target', 45);
			const verdicts: boolean[] = [];
			for (let i = 0; i < 8; i++)
				verdicts.push(
					await fastChatNotifyAllowed(fx.db, msg('payer', 'target', null, `burst-${i}`), new Date())
				);
			expect(verdicts).toEqual([true, true, true, true, true, false, false, false]);
		});

		it('one message gated twice (a recheck, or two routes) counts once', async () => {
			await fee('payer', 'target');
			await stored('payer', 'target', 48);
			for (let i = 0; i < 5; i++)
				expect(
					await fastChatNotifyAllowed(fx.db, msg('payer', 'target', null, 'same'), new Date())
				).toBe(true);
			expect(
				await fastChatNotifyAllowed(fx.db, msg('payer', 'target', null, 'second'), new Date())
			).toBe(true);
		});

		it('at the last free slot, the same message gated again still passes', async () => {
			await fee('payer', 'target');
			await stored('payer', 'target', 49);
			expect(
				await fastChatNotifyAllowed(fx.db, msg('payer', 'target', null, 'last'), new Date())
			).toBe(true);
			expect(
				await fastChatNotifyAllowed(fx.db, msg('payer', 'target', null, 'last'), new Date())
			).toBe(true);
			expect(
				await fastChatNotifyAllowed(fx.db, msg('payer', 'target', null, 'over'), new Date())
			).toBe(false);
		});

		it('the 21st paying stranger in a day is not announced', async () => {
			for (let i = 1; i <= 20; i++) {
				await fee(`sock${i}`, 'target');
				await stored(`sock${i}`, 'target', 1);
			}
			await fee('sock21', 'target');
			expect(await fastChatNotifyAllowed(fx.db, msg('sock21', 'target'), new Date())).toBe(false);
			// …while one of the 20 already counted still is.
			expect(await fastChatNotifyAllowed(fx.db, msg('sock3', 'target'), new Date())).toBe(true);
		});

		it('an order response is capped the same way (the bypass waives the fee, not the caps)', async () => {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method)
				 VALUES ('target', 'capped-order', 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'], 'live', NOW(), NOW(), 'verified', 'blurt')`
			);
			for (let i = 1; i <= 20; i++) await stored(`buyer${i}`, 'target', 1);
			expect(
				await fastChatNotifyAllowed(fx.db, msg('buyer21', 'target', 'capped-order'), new Date())
			).toBe(false);
			await stored('buyer1', 'target', 49);
			expect(
				await fastChatNotifyAllowed(fx.db, msg('buyer1', 'target', 'capped-order'), new Date())
			).toBe(false);
			expect(
				await fastChatNotifyAllowed(fx.db, msg('buyer2', 'target', 'capped-order'), new Date())
			).toBe(true);
		});

		it('senders announced but never stored do not silence a real buyer (review 2, finding 1)', async () => {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method)
				 VALUES ('target', 'busy-order', 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'], 'live', NOW(), NOW(), 'verified', 'blurt')`
			);
			// 20 accounts push order responses they never broadcast: announced, never stored.
			for (let i = 1; i <= 20; i++)
				expect(
					await fastChatNotifyAllowed(fx.db, msg(`junk${i}`, 'target', 'busy-order'), new Date())
				).toBe(true);
			expect(
				await fastChatNotifyAllowed(fx.db, msg('buyer', 'target', 'busy-order'), new Date())
			).toBe(true);
		});

		it('an op the head tailer cannot verify does not count against its pair (review 2, finding 1)', async () => {
			await fee('payer', 'target');
			await stored('payer', 'target', 48);
			// The head tailer meets three ops "from" payer it cannot prove.
			const t = new HeadTailer({} as never, fx.db, {} as never, {
				signedBySigner: async () => false
			});
			const op = (n: number) => ({
				ref_block_num: 1,
				ref_block_prefix: 2,
				expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
				operations: [
					[
						'custom_json',
						{
							required_auths: [],
							required_posting_auths: ['payer'],
							id: 'morphit_chat_v1',
							json: JSON.stringify({
								recipient: 'target',
								ciphertext: Buffer.from(`forged ${n}`).toString('base64'),
								header: { client_tag: `forged-${n}`, ephemeral_pub: 'AAAA', nonce: 'AAAA' }
							})
						}
					]
				],
				extensions: [],
				signatures: []
			});
			await (t as unknown as { scanBlock(b: unknown): Promise<void> }).scanBlock({
				timestamp: new Date().toISOString().slice(0, 19),
				transaction_ids: ['a', 'b', 'c'],
				transactions: [op(1), op(2), op(3)]
			});
			t.stop();
			expect(
				await fastChatNotifyAllowed(fx.db, msg('payer', 'target', null, 'real'), new Date())
			).toBe(true);
		});

		it('a reply lifts both caps', async () => {
			await fee('payer', 'target');
			await stored('payer', 'target', 60);
			await stored('target', 'payer', 1);
			expect(await fastChatNotifyAllowed(fx.db, msg('payer', 'target'), new Date())).toBe(true);
		});
	});

	it("S-M1: the buyer's next message notifies a seller who just replied through this instance", async () => {
		const t0 = new Date();
		await push('seller', 'buyer', 'trx1', t0);
		expect(await pushes('seller')).toBe(1);
		noteOutboundChat('seller', 'buyer');
		await push('seller', 'buyer', 'trx2', new Date(t0.getTime() + 20_000));
		expect(await pushes('seller')).toBe(2);
	});

	it('S-M1: without a reply the cap still holds', async () => {
		const t0 = new Date();
		await push('seller', 'buyer', 'trx1', t0);
		await push('seller', 'buyer', 'trx2', new Date(t0.getTime() + 20_000));
		expect(await pushes('seller')).toBe(1);
	});

	it('S-M2: a push from "bobby" does not silence the first message from "bob"', async () => {
		const t0 = new Date();
		await push('alice', 'bobby', 'trx3', t0);
		await push('alice', 'bob', 'trx4', new Date(t0.getTime() + 1000));
		expect(await pushes('alice')).toBe(2);
	});

	it('S-M3: the no-reply cap outlives the relay pruning sent pushes (a day, not an hour)', async () => {
		await push('seller', 'stranger', 's1');
		await fx.db.query(`UPDATE push_pending SET sent_at = NOW() - INTERVAL '61 minutes'`);
		await prunePushTombstones(fx.db as never, 3600);
		await push('seller', 'stranger', 's2');
		expect(await pushes('seller', true)).toBe(0);
	});

	it('S-M3: chat tombstones are pruned after a day', async () => {
		await push('seller', 'stranger', 's1');
		await fx.db.query(`UPDATE push_pending SET sent_at = NOW() - INTERVAL '25 hours'`);
		expect(await prunePushTombstones(fx.db as never, 3600)).toBe(1);
	});
});
