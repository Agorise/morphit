/**
 * v1.20.0 (MK-H2, V3-3) — watching per-order BTC fee addresses without letting
 * abandoned orders starve a paying one.
 *
 * Before: awaiting_payment rows shared the txid re-check's budget (25 lookups
 * per 10-minute pass, longest-waiting first, 30-minute spacing), so ~1,000
 * never-paid orders (334 accounts × the 3-per-day cap) kept a PAID order
 * waiting 6.7 h (V3's harness). Now address checks have their own budget; an
 * order never looked at goes first (newest first); an address that showed no
 * money is looked at less and less often the older the order is; one where
 * money is on its way is looked at every pass; and the owner can ask for a
 * check now (rate-limited per order).
 *
 * Real Postgres; the explorer is a stub.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import {
	checkFeeAddressNow,
	FEE_CHECK_NOW_COOLDOWN_MS,
	recheckExternalFees,
	RECHECK_INTERVAL_MS
} from '../../src/indexer/fee/externalFeeRecheck';
import { feeCheckRoute } from '../../src/api/feeCheck';
import type { FeeVerifier } from '../../src/indexer/fee/verifier';

const T0 = Date.parse('2026-10-01T00:00:00Z');
const HOUR = 3_600_000;

describe.skipIf(!INTEGRATION_ENABLED)('BTC fee address checks (V3-3)', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await fx.db.query(`TRUNCATE orders CASCADE`);
	});

	const ins = (
		acct: string,
		perm: string,
		created: Date,
		idx: number,
		extra: { received?: number; unconfirmed?: number; checked?: Date } = {}
	) =>
		fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, amount_min, amount_max, price_model,
			   payment_methods, status, created_at, updated_at, fee_status, fee_method, btc_fee_xpub, btc_fee_index,
			   btc_fee_address, btc_fee_sats, btc_fee_received_sats, btc_fee_unconfirmed_sats, fee_rechecked_at)
			 VALUES ($1,$2,'sell','BTC','USD',10,100,'{"kind":"spread","percent":0}'::jsonb, ARRAY['cash'], 'live', $3, $3,
			   'awaiting_payment','btc','xpubX',$4,$5,1000,$6,$7,$8)`,
			[
				acct,
				perm,
				created,
				idx,
				`bc1qaddr${idx}`,
				extra.received ?? null,
				extra.unconfirmed ?? null,
				extra.checked ?? null
			]
		);

	function watcher(
		paid: Set<string>,
		seen: string[] = [],
		onWay: Set<string> = new Set()
	): FeeVerifier {
		return {
			name: 'stub',
			verify: async () => ({ kind: 'pending_external', reason: 'x' }),
			checkAddressPayment: async (address: string) => {
				seen.push(address);
				if (paid.has(address)) return { kind: 'paid', confirmedSats: 1000, unconfirmedSats: 0 };
				return { kind: 'not_yet', confirmedSats: 0, unconfirmedSats: onWay.has(address) ? 500 : 0 };
			}
		} as unknown as FeeVerifier;
	}

	it("1,000 abandoned orders do not delay a paid one (V3's scenario)", async () => {
		let idx = 0;
		for (let a = 0; a < 334; a++)
			for (let k = 0; k < 3; k++) await ins(`sock${a}`, `p${k}`, new Date(T0 - HOUR + a), idx++);
		await ins('alice', 'mine', new Date(T0 + 60_000), idx);
		const aliceAddr = `bc1qaddr${idx}`;
		let verifiedOnPass: number | null = null;
		for (let pass = 1; pass <= 50 && verifiedOnPass === null; pass++) {
			await recheckExternalFees({
				db: fx.db,
				verifiers: { btc: watcher(new Set([aliceAddr])) },
				amounts: { btcSatoshis: 1000 },
				now: new Date(T0 + 120_000 + pass * RECHECK_INTERVAL_MS),
				onChange: (id) => {
					if (id === 'alice/mine') verifiedOnPass = pass;
				}
			});
		}
		expect(verifiedOnPass).toBe(1);
	});

	it('looks at an address with no money less often as the order ages, and every pass once money shows up', async () => {
		const now = new Date(T0);
		// posted 2 days ago, last looked at 1 h ago, nothing seen: not due
		await ins('old', 'o1', new Date(T0 - 48 * HOUR), 1, {
			received: 0,
			unconfirmed: 0,
			checked: new Date(T0 - HOUR)
		});
		// posted 2 days ago, looked at 13 h ago: due
		await ins('old', 'o2', new Date(T0 - 48 * HOUR), 2, {
			received: 0,
			unconfirmed: 0,
			checked: new Date(T0 - 13 * HOUR)
		});
		// posted 10 min ago, looked at 6 min ago, nothing yet: due (young orders are watched closely)
		await ins('new', 'n1', new Date(T0 - 10 * 60_000), 3, {
			received: 0,
			unconfirmed: 0,
			checked: new Date(T0 - 6 * 60_000)
		});
		// posted 2 days ago, money on its way when looked at 3 min ago: due
		await ins('pay', 'w1', new Date(T0 - 48 * HOUR), 4, {
			received: 0,
			unconfirmed: 500,
			checked: new Date(T0 - 3 * 60_000)
		});
		const seen: string[] = [];
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: watcher(new Set(), seen) },
			amounts: { btcSatoshis: 1000 },
			now
		});
		expect(seen.sort()).toEqual(['bc1qaddr2', 'bc1qaddr3', 'bc1qaddr4']);
	});

	it('an address never looked at goes before every re-look, however old its order', async () => {
		for (let i = 0; i < 60; i++) {
			await ins(`s${i}`, 'p', new Date(T0 - 24 * HOUR + i), 100 + i, {
				received: 0,
				unconfirmed: 0,
				checked: new Date(T0 - 13 * HOUR)
			});
		}
		await ins('late', 'x', new Date(T0 - 72 * HOUR), 99); // posted while this node was down, never looked at
		const seen: string[] = [];
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: watcher(new Set(), seen) },
			amounts: { btcSatoshis: 1000 },
			now: new Date(T0)
		});
		expect(seen[0]).toBe('bc1qaddr99');
		expect(seen).toHaveLength(40);
	});

	it('address checks have their own budget: a flood of txid re-checks does not crowd them out', async () => {
		for (let i = 0; i < 60; i++) {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods, status,
				   created_at, updated_at, fee_status, fee_method, external_tx_id)
				 VALUES ($1, 't', 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'], 'live', $2, $2, 'pending_external', 'btc', $3)`,
				[`tx${i}`, new Date(T0 - HOUR), i.toString(16).padStart(64, '0')]
			);
		}
		await ins('alice', 'mine', new Date(T0 - 60_000), 9);
		const seen: string[] = [];
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: watcher(new Set(), seen) },
			amounts: { btcSatoshis: 1000 },
			now: new Date(T0)
		});
		expect(seen).toContain('bc1qaddr9');
	});

	it('the owner can ask for a check now, at most once per cooldown, only for an awaiting order', async () => {
		await ins('alice', 'mine', new Date(T0 - 60_000), 7);
		const deps = (t: number, paid: Set<string>) => ({
			db: fx.db,
			verifiers: { btc: watcher(paid) },
			amounts: { btcSatoshis: 1000 },
			now: new Date(t)
		});
		expect(
			await checkFeeAddressNow({ ...deps(T0, new Set()), account: 'alice', permlink: 'mine' })
		).toMatchObject({
			kind: 'checked',
			fee_status: 'awaiting_payment'
		});
		const again = await checkFeeAddressNow({
			...deps(T0 + 5_000, new Set(['bc1qaddr7'])),
			account: 'alice',
			permlink: 'mine'
		});
		expect(again).toMatchObject({ kind: 'cooldown' });
		expect(
			await checkFeeAddressNow({
				...deps(T0 + FEE_CHECK_NOW_COOLDOWN_MS, new Set(['bc1qaddr7'])),
				account: 'alice',
				permlink: 'mine'
			})
		).toMatchObject({
			kind: 'checked',
			fee_status: 'verified'
		});
		expect(
			await checkFeeAddressNow({
				...deps(T0 + 10 * FEE_CHECK_NOW_COOLDOWN_MS, new Set()),
				account: 'alice',
				permlink: 'mine'
			})
		).toEqual({
			kind: 'not_awaiting'
		});
		expect(
			await checkFeeAddressNow({ ...deps(T0, new Set()), account: 'nobody', permlink: 'x' })
		).toEqual({ kind: 'not_awaiting' });
	});

	it('POST /v1/orders/:account/:permlink/check-fee starts the check in the background and says when to ask again', async () => {
		await ins('alice', 'mine', new Date(T0 - 60_000), 8);
		let t = T0;
		// The background look reports the flip once it is written.
		let noteChange!: (orderId: string) => void;
		const changed = new Promise<string>((r) => (noteChange = r));
		const app = feeCheckRoute({
			db: fx.db,
			current: () => ({
				verifiers: { btc: watcher(new Set(['bc1qaddr8'])) },
				amounts: { btcSatoshis: 1000 }
			}),
			onChange: (orderId) => noteChange(orderId),
			clock: () => t
		});
		const r1 = await app.request('/alice/mine/check-fee', { method: 'POST' });
		expect(r1.status).toBe(200);
		// The request answers at once; the explorer look runs after it.
		expect(await r1.json()).toMatchObject({ checked: false, queued: true });
		const status = async () =>
			(
				await fx.db.query<{ fee_status: string }>(
					`SELECT fee_status FROM orders WHERE account = 'alice' AND permlink = 'mine'`
				)
			).rows[0]?.fee_status;
		expect(await changed).toBe('alice/mine');
		expect(await status()).toBe('verified');
		t += 1_000;
		const r2 = await app.request('/alice/mine/check-fee', { method: 'POST' });
		expect(r2.status).toBe(200);
		expect(await r2.json()).toMatchObject({
			fee_status: 'verified',
			checked: false,
			queued: false
		});
		const bad = await app.request('/Alice!/mine/check-fee', { method: 'POST' });
		expect(bad.status).toBe(400);
	});
});

describe.skipIf(!INTEGRATION_ENABLED)('BTC fee address cross-check routes (V3-5)', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});

	it("serves this node's fee address to peers and asks peers about it", async () => {
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods, status,
			   created_at, updated_at, fee_status, fee_method, btc_fee_xpub, btc_fee_index, btc_fee_address, btc_fee_sats)
			 VALUES ('alice', 'a1', 'sell', 'BTC', 'USD', '{}'::jsonb, ARRAY['cash'], 'live', NOW(), NOW(),
			   'awaiting_payment', 'btc', 'xpubA', 5, 'bc1qfive', 1000)`
		);
		const peerAnswer = { index: 6, address: 'bc1qsix', xpub: 'xpubA' };
		const appWith = (n: number) =>
			feeCheckRoute({
				db: fx.db,
				current: () => ({ verifiers: {}, amounts: {} }),
				onChange: () => {},
				crossCheck: {
					peers: async () =>
						Array.from({ length: n }, (_, i) => ({
							origin: `https://peer${i}.example`,
							hidden: false
						})),
					fetchJson: async () => peerAnswer
				}
			});
		const app = appWith(1);
		const own = await app.request('/alice/a1/btc-fee');
		expect(await own.json()).toEqual({ index: 5, address: 'bc1qfive', xpub: 'xpubA' });
		expect((await app.request('/alice/nope/btc-fee')).status).toBe(404);
		// One dissenting peer is not a majority: a single lying or
		// stale peer cannot flag an honest order.
		const lone = await app.request('/alice/a1/btc-fee-crosscheck');
		expect(await lone.json()).toEqual({
			verdict: 'unchecked',
			asked: 1,
			agreeing: 0,
			disagreeing: 1
		});
		const two = await appWith(2).request('/alice/a1/btc-fee-crosscheck');
		expect(await two.json()).toEqual({
			verdict: 'disagree',
			asked: 2,
			agreeing: 0,
			disagreeing: 2
		});
	});
});
