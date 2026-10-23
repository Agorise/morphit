/**
 * A sender whose posting key needs a chain read still gets the fast path
 * (v1.21.14 full chat audit, S-C1 and S-M4), and the pre-send check on
 * /v1/broadcast is bounded (S-M6).
 *
 *   - S-C1: an account with NO `accounts` row — every Blurt account older than
 *     Morphit's start block that never claimed a waiver or a first trade — was
 *     answered "unknown sender" by every fast route: no local delivery, no peer
 *     intake, no head tailer. Its messages arrived only through the durable
 *     poller, 45-63 s later, with no error anywhere.
 *   - S-M4: a key that needed the chain (that, or an unconfirmed row: every new
 *     account and every rotation, for a minute) deferred local delivery and the
 *     head tailer, and neither ever looked at the message again.
 *   - S-M6: every chat transaction handed to /v1/broadcast cost a signature
 *     recovery on the main thread before the chain had looked at it, junk
 *     included.
 *
 * Real Postgres, the real lookup with a quorum refresher standing in for the
 * chain, the real dispatcher and head tailer, real signatures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import {
	postingKeyLookupFromDb,
	verifyPushedChatOp,
	_resetSeenForTest,
	_resetKeyRefreshForTest
} from '../../src/indexer/chatFastFederation';
import { ChatFastDispatcher, PRE_VERIFY_PER_SEC } from '../../src/indexer/chatFastDispatcher';
import { HeadTailer, RECHECK_DELAYS_MS } from '../../src/indexer/headTailer';
import { trxSignedByPostingKey } from '../../src/indexer/chainTrxSignature';
import { chatEventBus } from '../../src/indexer/chatEventBus';
import { _resetFastEmitLedgerForTest } from '../../src/indexer/fastEmitLedger';

const { PrivateKey, cryptoUtils } = await import('@beblurt/dblurt');

const old = PrivateKey.fromSeed('ckr-old-account');
const oldPub = old.createPublic().toString();
const fresh = PrivateKey.fromSeed('ckr-new-account');
const freshPub = fresh.createPublic().toString();

let seq = 0;
function chatTrx(sender: string, key: typeof old) {
	const trx = {
		ref_block_num: 1,
		ref_block_prefix: 2,
		expiration: new Date(Date.now() + 60_000).toISOString().slice(0, 19),
		operations: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: [sender],
					id: 'morphit_chat_v1',
					json: JSON.stringify({
						recipient: 'bob',
						ciphertext: Buffer.from(`hi ${++seq}`).toString('base64'),
						header: { client_tag: `ckr-${seq}`, ephemeral_pub: 'AAAA', nonce: 'AAAA' }
					})
				}
			]
		],
		extensions: [],
		signatures: [] as string[]
	};
	return cryptoUtils.signTransaction(trx as never, [key]) as unknown as typeof trx;
}

/** The chain, as two agreeing operators would answer it. */
const chainKeys: Record<string, string> = { olduser: oldPub, newuser: freshPub };
let chainReads = 0;
const refresher = async (account: string): Promise<string | null> => {
	chainReads++;
	return chainKeys[account] ?? null;
};

const noProxies = { torSocks: '', i2pHttpProxy: '', lokinet: 'off' } as never;

describe.skipIf(!INTEGRATION_ENABLED)('fast path for senders whose key needs the chain', () => {
	let fx: IntegrationFixture;
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
		chainReads = 0;
		await fx.db.query('DELETE FROM chat_messages');
		await fx.db.query('DELETE FROM accounts');
		// newuser: a row the dispatcher wrote at creation, not yet confirmed.
		// olduser: no row at all (created before the start block).
		await fx.db.query(
			`INSERT INTO accounts (name, creator, created_block_num, created_block_time, created_trx_id,
			                       posting_pubkey, posting_key_reconciled)
			 VALUES ('newuser','genesis',1,now(),'s1',$1,FALSE), ('bob','genesis',1,now(),'s2',NULL,TRUE)`,
			[freshPub]
		);
	});

	const lookup = () => postingKeyLookupFromDb(fx.db, refresher, { durableIsCurrent: () => true });

	it('S-C1: a peer push from an account with no row verifies (the chain is asked)', async () => {
		const v = await verifyPushedChatOp({ trx: chatTrx('olduser', old) }, lookup());
		expect({ ok: v.ok, chainReads }).toEqual({ ok: true, chainReads: 1 });
	});

	it('S-C1: a forged push naming an account with no row is still refused', async () => {
		const v = await verifyPushedChatOp({ trx: chatTrx('olduser', fresh) }, lookup());
		expect(v.ok).toBe(false);
	});

	for (const who of ['olduser', 'newuser'] as const) {
		it(`S-C1/S-M4: local delivery of ${who}'s message happens once the node has accepted it`, async () => {
			const disp = new ChatFastDispatcher({
				db: fx.db,
				selfOrigin: 'https://self.example',
				proxies: noProxies,
				lookupPostingKey: lookup()
			});
			const h = disp.dispatchIfChat(chatTrx(who, who === 'olduser' ? old : fresh));
			expect(await h.decision).toBe('deferred');
			h.chainAccepted();
			expect(await h.verifiedHere()).toBe(true);
		});
	}

	it('S-C1/S-M4: a deferred message signed by the wrong key is not delivered locally', async () => {
		const disp = new ChatFastDispatcher({
			db: fx.db,
			selfOrigin: 'https://self.example',
			proxies: noProxies,
			lookupPostingKey: lookup()
		});
		const h = disp.dispatchIfChat(chatTrx('olduser', fresh));
		h.chainAccepted();
		expect(await h.verifiedHere()).toBe(false);
	});

	it('S-M4: verifiedHere is false until the node has accepted a deferred message', async () => {
		const disp = new ChatFastDispatcher({
			db: fx.db,
			selfOrigin: 'https://self.example',
			proxies: noProxies,
			lookupPostingKey: lookup()
		});
		const h = disp.dispatchIfChat(chatTrx('olduser', old));
		expect(await h.verifiedHere()).toBe(false);
		expect(chainReads).toBe(0);
	});

	describe('head tailer rechecks (fake timers)', () => {
		beforeEach(() => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		});
		afterEach(() => {
			vi.useRealTimers();
		});
		const scan = async (tailer: HeadTailer, trx: unknown) =>
			(tailer as unknown as { scanBlock(b: unknown): Promise<void> }).scanBlock({
				timestamp: new Date().toISOString().slice(0, 19),
				transaction_ids: ['x'],
				transactions: [trx]
			});

		for (const who of ['olduser', 'newuser'] as const) {
			it(`S-M4: the head tailer shows ${who}'s message once the key read answers`, async () => {
				const emitted: string[] = [];
				const off = chatEventBus.onFast((ev) => emitted.push(ev.sender));
				const tailer = new HeadTailer({} as never, fx.db, {} as never, {
					signedBySigner: trxSignedByPostingKey(lookup())
				});
				try {
					await scan(tailer, chatTrx(who, who === 'olduser' ? old : fresh));
					expect(emitted).toEqual([]);
					await vi.advanceTimersByTimeAsync(RECHECK_DELAYS_MS[0] ?? 0);
					await vi.waitFor(() => expect(emitted).toEqual([who]));
					expect(tailer.getStatus().rechecked).toBe(1);
				} finally {
					off();
					tailer.stop();
				}
			});
		}

		it('S-M4: a head-block message signed by the wrong key is never shown, however often it is rechecked', async () => {
			const emitted: string[] = [];
			const off = chatEventBus.onFast((ev) => emitted.push(ev.sender));
			const tailer = new HeadTailer({} as never, fx.db, {} as never, {
				signedBySigner: trxSignedByPostingKey(lookup())
			});
			try {
				await scan(tailer, chatTrx('olduser', fresh));
				// The first try and one recheck per delay, each refused. A recheck
				// reads the database, so the next one is scheduled only once it is
				// done: wait for each before moving the clock on.
				expect(tailer.getStatus().unverified).toBe(1);
				for (const [i, d] of RECHECK_DELAYS_MS.entries()) {
					await vi.advanceTimersByTimeAsync(d);
					await vi.waitFor(() => expect(tailer.getStatus().unverified).toBe(i + 2));
				}
				await vi.advanceTimersByTimeAsync(60_000);
				expect(tailer.getStatus().unverified).toBe(RECHECK_DELAYS_MS.length + 1);
				expect(emitted).toEqual([]);
			} finally {
				off();
				tailer.stop();
			}
		});
	});

	it('S-M6: past the per-second budget a chat transaction is not checked before the chain', async () => {
		let lookups = 0;
		const counting = postingKeyLookupFromDb(fx.db, refresher, { durableIsCurrent: () => true });
		const disp = new ChatFastDispatcher({
			db: fx.db,
			selfOrigin: 'https://self.example',
			proxies: noProxies,
			lookupPostingKey: async (a, o) => {
				lookups++;
				return counting(a, o);
			}
		});
		const decisions = await Promise.all(
			Array.from(
				{ length: PRE_VERIFY_PER_SEC + 5 },
				() => disp.dispatchIfChat(chatTrx('olduser', fresh)).decision
			)
		);
		expect(decisions.every((d) => d === 'deferred')).toBe(true);
		expect(lookups).toBe(PRE_VERIFY_PER_SEC);
		expect(disp.status().preVerifySkipped).toBe(5);
	});
});
