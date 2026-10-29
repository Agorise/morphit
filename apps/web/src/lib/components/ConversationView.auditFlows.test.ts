// @vitest-environment jsdom
/**
 * The REAL ConversationView wiring for the v1.21.14 full chat audit:
 *
 *   W-H1  the money-flow row and "already paid" read the trade with THIS
 *         peer — another inquirer's claim about the same order hid them;
 *   W-L5  the modals stay open (with their error) when the send failed, and
 *         the Pay-now receipt toast says so — sendMessage never throws, so
 *         every modal closed and the success toast showed whatever happened;
 *   W-M3  the read-acks, local and on chain, carry the newest message shown —
 *         the route acked with the device clock;
 *   W-M2  a message refused over a changed key opens Verify peer, and is sent
 *         again once the shown key is accepted there (W-L8: the panel needs
 *         no format any more — it compares posting keys, which every message
 *         is sent to since v1.21.14);
 *   W-L6  the bubbles know who owns the thread's order;
 *   W-L7  the composer's draft is the thread's.
 *
 * The controller is a fake the test drives (deps.onChange / onHistoryChange
 * are what the real one calls); everything else is real or stubbed I/O.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/stores', () => ({
	page: readable({ url: new URL('http://localhost/en/chat/bob'), params: { lang: 'en' } })
}));
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string) => k),
	locale: readable('en')
}));
const live = { posting: { privateKey: new Uint8Array(32).fill(1) } };
vi.mock('$stores/identity', () => ({
	liveIdentity: readable(live),
	isUnlocked: readable(true),
	isPairedReadOnly: readable(false)
}));

interface FakeDeps {
	onChange(m: readonly unknown[]): void;
	onHistoryChange?(h: unknown): void;
}
const ctl = vi.hoisted(() => ({
	deps: null as unknown,
	outcome: { ok: true } as { ok: boolean; error?: string },
	retried: [] as number[],
	sent: [] as string[]
}));
vi.mock('$lib/chat/chatService', async (orig) => ({
	...((await orig()) as object),
	runtimeDeps: () => ({}),
	createConversationController: (deps: unknown) => {
		ctl.deps = deps;
		return {
			start: () => {},
			destroy: () => {},
			sendMessage: async (t: string) => {
				ctl.sent.push(t);
				return ctl.outcome;
			},
			retryMessage: async (s: number) => void ctl.retried.push(s),
			lockGeneration: () => 0,
			loadOlder: async () => {},
			snapshot: () => []
		};
	}
}));
vi.mock('$blurt/accountKeys', () => ({ fetchAccountKeys: async () => null }));
vi.mock('$lib/indexer/profileCache', async (orig) => ({
	...((await orig()) as object),
	getProfileCached: async () => null
}));
vi.mock('$lib/chat/blocks', () => ({
	blockedAccounts: readable(new Set<string>()),
	loadBlocks: async () => {},
	markBlocked: () => {},
	markUnblocked: () => {}
}));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock('$lib/stores/toast', () => ({ showToast: (m: string) => void toasts.push(m) }));
const chainAcks = vi.hoisted(() => [] as unknown[][]);
/** Broadcasts still to fail (an RPC outage). */
const chainAckFailures = vi.hoisted(() => ({ left: 0 }));
vi.mock('$blurt/ops/chatRead', () => ({
	broadcastChatRead: async (...a: unknown[]) => {
		chainAcks.push(a);
		if (chainAckFailures.left > 0) {
			chainAckFailures.left--;
			throw new Error('rpc down');
		}
		return { block_num: 1, trx_id: 'x' };
	}
}));
/** Verify peer and Pay BLURT are stand-ins that record what they were given. */
const panel = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('$components/VerifyPeerPanel.svelte', () => ({
	default: (_anchor: unknown, props: Record<string, unknown>) => {
		panel.props = props;
	}
}));
vi.mock('$components/PayBlurtModal.svelte', () => ({
	default: (_anchor: unknown, props: { onPaid: (a: unknown) => void }) => {
		queueMicrotask(() => props.onPaid({ trxId: 'c'.repeat(40), blockNum: 1, amount: 5 }));
	}
}));

let served: { owner: string; item: Record<string, unknown> } | null = null;
/** This many order reads fail (a timeout, as on a slow Tor/I2P link) first. */
let orderReadsFailing = 0;
/** Every order read. */
let orderReads = 0;
/** Views mounted by a test, closed after it (a view left open reads on). */
const openViews: (() => void)[] = [];
vi.mock('$lib/indexer/client', () => ({
	getChatAdmission: async (me: string, peer: string) => ({
		ok: true,
		data: { me, peer, admitted: true, reason: 'prior_contact' }
	}),
	getOrder: async (owner: string) => {
		orderReads++;
		if (orderReadsFailing > 0) {
			orderReadsFailing--;
			return { ok: false, code: 'timeout', message: 'x' };
		}
		return served !== null && owner === served.owner
			? { ok: true, data: { item: served.item } }
			: { ok: false, code: 'not_found', message: 'x' };
	},
	getReputationReceipt: async () => ({ ok: false, error: { code: 'x', message: 'x' } }),
	getFeedbackGiven: async () => ({ ok: false, error: { code: 'x', message: 'x' } }),
	getPaymentCheck: async (q: Record<string, unknown>) => {
		paymentCheckAsks.push(q);
		return paymentCheckAnswer;
	}
}));
/** What the chain says about a BLURT payment, and what it was asked
 *  (v1.21.17, the BLURT leg of a crypto-for-crypto trade). */
const blurtChain = vi.hoisted(() => ({
	answer: { kind: 'not_found' } as
		| Record<string, unknown>
		| ((expect: Record<string, unknown>) => Record<string, unknown>),
	asks: [] as Record<string, unknown>[]
}));
vi.mock('$lib/chat/blurtVerify', async (orig) => ({
	...((await orig()) as object),
	verifyBlurtTransfer: async (txid: string, expect: Record<string, unknown>) => {
		blurtChain.asks.push({ txid, ...expect });
		const a = blurtChain.answer;
		return typeof a === 'function' ? a(expect) : a;
	}
}));
/** What /v1/payment-check answers, and what it was asked (v1.21.17). */
let paymentCheckAnswer: unknown = { ok: false, code: 'x', message: 'x' };
const paymentCheckAsks: Record<string, unknown>[] = [];
/** The order's payment methods (default: a fiat method, the one-leg flow). */
let orderMethods: string[] = ['paypal'];
/** The order's status as served (default live). */
let orderStatus = 'live';

const ME = 'alice';
const PEER = 'bob';
const ORDER = 'bob-sells-xmr';

function order(owner: string, side: 'buy' | 'sell', asset = 'XMR') {
	return {
		account: owner,
		permlink: ORDER,
		side,
		asset,
		fiat_currency: 'MXN',
		amount_min: 100,
		amount_max: 500,
		payment_methods: orderMethods,
		price_model: { kind: 'fixed', price: 1 },
		location_region: null,
		accepted_assets: null,
		specific_barter_title: null,
		terms: null,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		expires_at: null,
		status: orderStatus
	};
}

// jsdom has no layout: scrolling is a no-op here.
Element.prototype.scrollTo = function () {} as never;

beforeAll(async () => {
	await import('svelte');
	await import('./ConversationView.svelte');
}, 120_000);

afterEach(async () => {
	for (const close of openViews.splice(0)) close();
	(await import('$lib/trades/tradeStatus')).clearAllTradeStates();
	(await import('$lib/chat/legLedger')).clearLegLedger();
	(await import('$lib/chat/chainAckMemory')).clearChainAckMemory();
	document.body.innerHTML = '';
	served = null;
	orderReadsFailing = 0;
	ctl.outcome = { ok: true };
	ctl.retried.length = 0;
	ctl.sent.length = 0;
	toasts.length = 0;
	chainAcks.length = 0;
	chainAckFailures.left = 0;
	panel.props = null;
	localStorage.clear();
});

async function render(owner: string, side: 'buy' | 'sell', asset = 'XMR', failReads = 0) {
	served = { owner, item: order(owner, side, asset) };
	orderReadsFailing = failReads;
	const { mount, unmount, flushSync } = await import('svelte');
	const { default: ConversationView } = await import('./ConversationView.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	const app = mount(ConversationView, {
		target,
		props: { me: ME, peer: PEER, orderPermlink: ORDER }
	});
	await vi.waitFor(() => {
		flushSync();
		if (failReads === 0) expect(target.textContent).toMatch(/order_title(_3p)?\./);
		expect(target.querySelector('textarea')).not.toBeNull();
	});
	const deps = ctl.deps as FakeDeps;
	const push = async (messages: Record<string, unknown>[]) => {
		deps.onChange(
			messages.map((m, i) => ({
				id: i + 1,
				clientTag: null,
				sender: PEER,
				state: 'confirmed',
				createdAt: new Date('2026-10-21T12:00:00Z'),
				orderPermlink: ORDER,
				trxId: null,
				error: null,
				decryptFailed: false,
				localSeq: i + 1,
				text: 'hi',
				...m
			}))
		);
		await Promise.resolve();
		flushSync();
	};
	const button = (pred: (b: HTMLButtonElement) => boolean) =>
		[...target.querySelectorAll('button')].find(pred) as HTMLButtonElement | undefined;
	const settle = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve();
		flushSync();
	};
	let open = true;
	const destroy = (): void => {
		if (open) unmount(app);
		open = false;
	};
	openViews.push(destroy);
	return { target, deps, push, button, settle, flushSync, destroy };
}

describe('W-H1: the thread reads the trade with ITS peer', () => {
	it('another inquirer’s "paid" claim about the same order leaves this thread’s row', async () => {
		const ts = await import('$lib/trades/tradeStatus');
		ts.clearAllTradeStates();
		ts.recordFundsSent({
			orderOwner: PEER,
			orderPermlink: ORDER,
			peer: 'mallory',
			method: 'xmr',
			txid: 'a'.repeat(64),
			direction: 'incoming'
		});
		const v = await render(PEER, 'sell');
		expect(
			v.target.querySelector('button[aria-label^="chat.address.share_button_aria"]')
		).not.toBeNull();
		// This peer's own receipt: the row goes.
		ts.recordFundsSent({
			orderOwner: PEER,
			orderPermlink: ORDER,
			peer: PEER,
			method: 'xmr',
			txid: 'b'.repeat(64),
			direction: 'incoming'
		});
		v.flushSync();
		expect(
			v.target.querySelector('button[aria-label^="chat.address.share_button_aria"]')
		).toBeNull();
	});
});

describe('C-L3: whose order it is, read again until known; money actions closed meanwhile', () => {
	const pay = async () =>
		(await import('$lib/chat/payload')).encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'blurt',
			address: PEER,
			amount: '5',
			orderPermlink: ORDER
		});
	const payNow = (v: { button: (p: (b: HTMLButtonElement) => boolean) => unknown }) =>
		v.button((b) => (b.textContent ?? '').includes('chat.address.pay_now'));
	/** The first back-off of the order read has passed. */
	const backOff = async (v: { settle: () => Promise<void> }) => {
		await vi.advanceTimersByTimeAsync(2_000);
		await v.settle();
	};
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('the order read fails first: no Pay now until it is read again; then a payment already made keeps it hidden', async () => {
		const ts = await import('$lib/trades/tradeStatus');
		// We already paid bob for his order.
		ts.recordFundsSent({
			orderOwner: PEER,
			orderPermlink: ORDER,
			peer: PEER,
			method: 'blurt',
			txid: 'c'.repeat(40),
			direction: 'outgoing'
		});
		const v = await render(PEER, 'buy', 'BLURT', 1);
		await v.push([{ text: await pay() }]);
		expect(v.target.textContent).not.toMatch(/order_title(_3p)?\./);
		expect(payNow(v)).toBeUndefined();
		// Read again (after the first back-off): the owner is known, and the
		// payment already made hides Pay now.
		await backOff(v);
		expect(v.target.textContent).toMatch(/order_title(_3p)?\./);
		expect(payNow(v)).toBeUndefined();
	});

	it('not paid yet: Pay now appears once the order is read again', async () => {
		const v = await render(PEER, 'buy', 'BLURT', 1);
		await v.push([{ text: await pay() }]);
		expect(payNow(v)).toBeUndefined();
		await backOff(v);
		expect(payNow(v)).toBeDefined();
	});

	it('the view closed: the order is not read again', async () => {
		const v = await render(PEER, 'buy', 'BLURT', 100);
		await v.settle();
		v.destroy();
		const reads = orderReads;
		await vi.advanceTimersByTimeAsync(300_000);
		expect(orderReads).toBe(reads);
	});
});

describe('W-L5: a failed send keeps the modal open and says so', () => {
	async function shareAddress(ok: boolean) {
		const ts = await import('$lib/trades/tradeStatus');
		ts.clearAllTradeStates();
		ctl.outcome = ok ? { ok: true } : { ok: false, error: 'broadcast_err:insufficient_funds' };
		// A BTC order: the address modal offers only the order's coin (v1.21.16).
		const v = await render(PEER, 'sell', 'BTC');
		v.target
			.querySelector<HTMLButtonElement>('button[aria-label^="chat.address.share_button_aria"]')!
			.click();
		v.flushSync();
		const input = v.target.querySelector(
			'input[placeholder="chat.address.address_placeholder_btc"]'
		) as HTMLInputElement;
		input.value = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		v.flushSync();
		v.button((b) => (b.textContent ?? '').trim() === 'chat.address.send')!.click();
		await v.settle();
		return v;
	}

	it('the node refused it: the address modal stays, with its error', async () => {
		const v = await shareAddress(false);
		expect(ctl.sent).toHaveLength(1);
		expect(v.target.querySelector('[aria-labelledby="address-share-heading"]')).not.toBeNull();
		expect(v.target.textContent).toContain('chat.address.send_failed');
	});

	it('an XMR order: the modal asks for an XMR address, not another coin’s', async () => {
		const ts = await import('$lib/trades/tradeStatus');
		ts.clearAllTradeStates();
		const v = await render(PEER, 'sell', 'XMR');
		v.target
			.querySelector<HTMLButtonElement>('button[aria-label^="chat.address.share_button_aria"]')!
			.click();
		v.flushSync();
		const placeholders = [...v.target.querySelectorAll('input[placeholder]')].map((i) =>
			i.getAttribute('placeholder')
		);
		expect(placeholders).toContain('chat.address.address_placeholder_xmr');
		expect(placeholders).not.toContain('chat.address.address_placeholder_btc');
		v.destroy();
	});

	it('the node took it: the modal closes', async () => {
		const v = await shareAddress(true);
		expect(ctl.sent).toHaveLength(1);
		expect(v.target.querySelector('[aria-labelledby="address-share-heading"]')).toBeNull();
	});

	it('Pay now: a receipt that could not be posted gets the "copy this txid" toast, not "posted"', async () => {
		const { encodeAddressPayload } = await import('$lib/chat/payload');
		const pay = encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'blurt',
			address: PEER,
			amount: '5',
			orderPermlink: ORDER
		});
		const ts = await import('$lib/trades/tradeStatus');
		for (const ok of [false, true]) {
			ts.clearAllTradeStates();
			ctl.outcome = ok ? { ok: true } : { ok: false, error: 'chain_unreachable' };
			toasts.length = 0;
			const v = await render(PEER, 'buy', 'BLURT');
			await v.push([{ text: pay }]);
			v.button((b) => (b.textContent ?? '').includes('chat.address.pay_now'))!.click();
			await v.settle();
			await v.settle();
			expect(toasts).toEqual([
				ok ? 'chat.pay_blurt.success_toast' : 'chat.pay_blurt.success_toast_no_chat_with_txid'
			]);
			document.body.innerHTML = '';
		}
	});
});

describe('W-M3: the acks carry the newest message shown', () => {
	it('local and on chain: the newest confirmed message’s time, once the first answer is in', async () => {
		const { getLastVisited } = await import('$lib/chat/readState');
		const v = await render(PEER, 'sell');
		expect(chainAcks).toEqual([]);
		await v.push([
			{ createdAt: new Date('2026-10-21T11:00:00Z') },
			{ createdAt: new Date('2026-10-21T11:30:00Z') },
			{ createdAt: null, state: 'pending', sender: ME }
		]);
		expect(getLastVisited(PEER, ORDER)).toBe('2026-10-21T11:30:00.000Z');
		v.deps.onHistoryChange?.({ ready: true, loading: false, complete: false, failed: false });
		await v.settle();
		expect(chainAcks).toHaveLength(1);
		expect(chainAcks[0]!.slice(1, 3)).toEqual([PEER, ORDER]);
		expect((chainAcks[0]![3] as Date).toISOString()).toBe('2026-10-21T11:30:00.000Z');
		// Once per visit.
		v.deps.onHistoryChange?.({ ready: true, loading: true, complete: false, failed: false });
		await v.settle();
		expect(chainAcks).toHaveLength(1);
	});

	it('nothing shown: no ack at all (never the device clock)', async () => {
		const { getLastVisited, clearReadState } = await import('$lib/chat/readState');
		clearReadState();
		const v = await render(PEER, 'sell');
		v.deps.onHistoryChange?.({ ready: true, loading: false, complete: true, failed: false });
		await v.settle();
		expect(getLastVisited(PEER, ORDER)).toBeNull();
		expect(chainAcks).toEqual([]);
	});
});

describe('v1.21.17: a crypto-for-crypto trade, one step at a time', () => {
	// The maintainer's first live trade: @bob's order "buying BLURT with
	// XMR or BTC". The BLURT seller saw "Send BLURT" at once (and sent it), the
	// buyer saw "Share your Blurt account", and the buyer was never shown where
	// to pay the XMR/BTC. Here ME (alice) is the seller, PEER (bob) the buyer.
	const XMR_ADDR =
		'47ohRcAbr8b8iaqq3sQWm795zAr8V5DKSLzfLDihsi55W4xaZ5dBu3zVnkqE7zMVc7ckPgz8AHYai96BzyNF4D4X5eSHr7B';
	const txidN = (n: number) => n.toString(16).padStart(64, '0');
	const KEY = 'c'.repeat(64);
	const has = (v: { target: HTMLElement }, aria: string) =>
		v.target.querySelector(`button[aria-label^="${aria}"]`) !== null;
	const hint = (v: { target: HTMLElement }) =>
		v.target.querySelector('[data-testid="chat-leg-hint"]')?.textContent?.trim() ?? '';
	const addressMsg = async (id = 1) => {
		const { encodeAddressPayload } = await import('$lib/chat/payload');
		return {
			id,
			sender: ME,
			createdAt: new Date('2026-10-26T18:00:00Z'),
			text: encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'xmr',
				address: XMR_ADDR,
				amount: '0.05',
				orderPermlink: ORDER
			})
		};
	};
	const receiptMsg = async (
		txid: string,
		opts: { id?: number; key?: boolean; at?: string; order?: string } = {}
	) => {
		const { encodeFundsSentPayload } = await import('$lib/chat/payload');
		return {
			id: opts.id ?? 2,
			sender: PEER,
			createdAt: new Date(opts.at ?? '2026-10-26T18:05:00Z'),
			text: encodeFundsSentPayload({
				v: 1,
				kind: 'morphit_funds_sent',
				method: 'xmr',
				txid,
				...(opts.key === false ? {} : { txKey: KEY }),
				orderPermlink: opts.order ?? ORDER
			})
		};
	};
	const msgs = async (txid: string) => [await addressMsg(), await receiptMsg(txid)];
	const found = (amount: string, confirmations: number, txTime = '2026-10-26T18:04:00Z') => ({
		ok: true,
		data: {
			asset: 'xmr',
			txid: 'x',
			status: 'found',
			amount,
			confirmations,
			required_confirmations: 3,
			checked_at: '2026-10-26T18:06:00Z',
			tx_time: txTime
		}
	});
	beforeEach(() => {
		orderMethods = ['pay_xmr', 'pay_btc'];
		paymentCheckAsks.length = 0;
	});
	afterEach(() => {
		orderMethods = ['paypal'];
		orderStatus = 'live';
		paymentCheckAnswer = { ok: false, code: 'x', message: 'x' };
	});

	it('the seller first shares an XMR/BTC address — no "Send BLURT" before he is paid', async () => {
		const v = await render(PEER, 'buy', 'BLURT');
		expect(has(v, 'chat.address.share_button_aria_asset')).toBe(true);
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		expect(hint(v)).toBe('chat.legs.waiting_payment');
	});

	it('the buyer’s payment seen at 0 confirmations: "Send BLURT"; the receipt shows the check', async () => {
		paymentCheckAnswer = found('0.05', 0);
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push(await msgs(txidN(1)));
		await vi.waitFor(() => {
			v.flushSync();
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		});
		expect(has(v, 'chat.address.share_button_aria_asset')).toBe(false);
		expect(paymentCheckAsks[0]).toEqual({
			asset: 'xmr',
			txid: txidN(1),
			address: XMR_ADDR,
			txKey: KEY
		});
		expect(v.target.querySelector('[data-testid="payment-check"]')?.textContent?.trim()).toBe(
			'chat.payment_check.seen'
		);
	});

	it('his BLURT receipt failed to post: "Send BLURT" does not come back', async () => {
		paymentCheckAnswer = found('0.05', 0);
		const v = await render(PEER, 'buy', 'BLURT');
		const { encodeFundsSentPayload } = await import('$lib/chat/payload');
		const mine = {
			id: 3,
			sender: ME,
			state: 'failed',
			createdAt: new Date('2026-10-26T18:10:00Z'),
			text: encodeFundsSentPayload({
				v: 1,
				kind: 'morphit_funds_sent',
				method: 'blurt',
				txid: 'd'.repeat(40),
				orderPermlink: ORDER
			})
		};
		await v.push(await msgs(txidN(9)));
		await vi.waitFor(() => {
			v.flushSync();
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		});
		await v.push([...(await msgs(txidN(9))), mine]);
		await v.settle();
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
	});

	it('paid from the app, its receipt never in the thread: "Send BLURT" does not come back, even in a new view', async () => {
		paymentCheckAnswer = found('0.05', 0);
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push(await msgs(txidN(10)));
		await vi.waitFor(() => {
			v.flushSync();
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		});
		v.button((b) =>
			(b.getAttribute('aria-label') ?? '').startsWith('chat.funds_sent.button_aria')
		)!.click();
		await vi.waitFor(() => {
			v.flushSync();
			expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		});
		v.destroy();
		// The view opened again (the receipt never posted): still no "Send BLURT".
		const again = await render(PEER, 'buy', 'BLURT');
		await again.push(await msgs(txidN(10)));
		await again.settle();
		await vi.waitFor(() => {
			again.flushSync();
			expect(paymentCheckAsks.length).toBeGreaterThan(1);
		});
		await again.settle();
		expect(has(again, 'chat.funds_sent.button_aria')).toBe(false);
	});

	it('not seen yet: no "Send BLURT", and he is told it is being checked', async () => {
		paymentCheckAnswer = {
			ok: true,
			data: {
				asset: 'xmr',
				txid: 'x',
				status: 'not_found',
				amount: null,
				confirmations: null,
				required_confirmations: 3,
				checked_at: 'x'
			}
		};
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push(await msgs(txidN(2)));
		await vi.waitFor(() => {
			v.flushSync();
			expect(paymentCheckAsks).toHaveLength(1);
		});
		await v.settle();
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		expect(hint(v)).toBe('chat.legs.checking_payment');
	});

	it('less than asked: no "Send BLURT"', async () => {
		paymentCheckAnswer = found('0.04', 1);
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push(await msgs(txidN(3)));
		await vi.waitFor(() => {
			v.flushSync();
			expect(hint(v)).toBe('chat.legs.payment_short');
		});
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
	});

	it('the explorers cannot be asked (yet): no "Send BLURT" — still checking', async () => {
		paymentCheckAnswer = { ok: false, code: 'unavailable', message: 'x' };
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push(await msgs(txidN(4)));
		await vi.waitFor(() => {
			v.flushSync();
			expect(paymentCheckAsks.length).toBeGreaterThan(0);
		});
		await v.settle();
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		expect(hint(v)).toBe('chat.legs.checking_payment');
	});

	it('cannot be confirmed here (no Monero key): "Send BLURT" only once he says he sees it in his wallet', async () => {
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push([await addressMsg(), await receiptMsg(txidN(5), { key: false })]);
		await vi.waitFor(() => {
			v.flushSync();
			expect(hint(v)).toBe('chat.legs.check_wallet');
		});
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		const confirm = v.target.querySelector<HTMLButtonElement>(
			'[data-testid="chat-leg-wallet-confirm"]'
		);
		expect(confirm).not.toBeNull();
		confirm!.click();
		v.flushSync();
		expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		expect(hint(v)).toBe('chat.legs.send_unchecked');
	});

	it('his "I see it in my wallet" covers what the check said then: found short later, he is told so and "Send BLURT" goes', async () => {
		const v = await render(PEER, 'buy', 'BLURT');
		const first = [await addressMsg(), await receiptMsg(txidN(13), { key: false })];
		await v.push(first);
		await vi.waitFor(() => {
			v.flushSync();
			expect(hint(v)).toBe('chat.legs.check_wallet');
		});
		v.target.querySelector<HTMLButtonElement>('[data-testid="chat-leg-wallet-confirm"]')!.click();
		v.flushSync();
		expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		// The buyer adds the Monero key: the check now finds less than asked.
		paymentCheckAnswer = found('0.01', 1);
		await v.push([...first, await receiptMsg(txidN(13), { id: 3, at: '2026-10-26T18:20:00Z' })]);
		await vi.waitFor(() => {
			v.flushSync();
			expect(hint(v)).toBe('chat.legs.payment_short');
		});
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		// He may still say his wallet shows it (paid in two parts): his word again.
		expect(v.target.querySelector('[data-testid="chat-leg-wallet-confirm"]')).not.toBeNull();
	});

	it('a payment made before the address was shared is not this trade’s: no "Send BLURT"', async () => {
		paymentCheckAnswer = found('0.05', 3, '2026-10-20T00:00:00Z');
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push(await msgs(txidN(6)));
		await vi.waitFor(() => {
			v.flushSync();
			expect(hint(v)).toBe('chat.legs.payment_old');
		});
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		// No "I see it in my wallet" for a payment that predates his address.
		expect(v.target.querySelector('[data-testid="chat-leg-wallet-confirm"]')).toBeNull();
		expect(v.target.querySelector('[data-testid="payment-check"]')?.textContent?.trim()).toBe(
			'chat.payment_check.old'
		);
	});

	it('a receipt before any address of its coin: no "Send BLURT"; he can still share one', async () => {
		paymentCheckAnswer = found('0.05', 0);
		const v = await render(PEER, 'buy', 'BLURT');
		// The receipt comes first; an address shared after it is not what was paid.
		await v.push([
			await receiptMsg(txidN(7), { id: 1, at: '2026-10-26T17:00:00Z' }),
			{ ...(await addressMsg(2)), createdAt: new Date('2026-10-26T18:00:00Z') }
		]);
		await vi.waitFor(() => {
			v.flushSync();
			expect(hint(v)).toBe('chat.legs.payment_no_address');
		});
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		expect(has(v, 'chat.address.share_button_aria_asset')).toBe(true);
		expect(paymentCheckAsks).toHaveLength(0);
	});

	it('a receipt in a coin with no check here (LTC), before any LTC address: "no address", not his own call', async () => {
		orderMethods = ['pay_ltc'];
		const { encodeFundsSentPayload } = await import('$lib/chat/payload');
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push([
			{
				id: 1,
				sender: PEER,
				createdAt: new Date('2026-10-26T18:05:00Z'),
				text: encodeFundsSentPayload({
					v: 1,
					kind: 'morphit_funds_sent',
					method: 'ltc',
					txid: txidN(15),
					orderPermlink: ORDER
				})
			}
		]);
		await vi.waitFor(() => {
			v.flushSync();
			expect(hint(v)).toBe('chat.legs.payment_no_address');
		});
		expect(v.target.querySelector('[data-testid="chat-leg-wallet-confirm"]')).toBeNull();
		expect(has(v, 'chat.address.share_button_aria_asset')).toBe(true);
	});

	it('a txid already cited for ANOTHER order is not a new payment; he is told so', async () => {
		paymentCheckAnswer = found('0.05', 0);
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push([
			await receiptMsg(txidN(8), { id: 1, at: '2026-10-26T17:00:00Z', order: 'order-other' }),
			await addressMsg(2),
			await receiptMsg(txidN(8), { id: 3, at: '2026-10-26T18:10:00Z' })
		]);
		await vi.waitFor(() => {
			v.flushSync();
			expect(hint(v)).toBe('chat.legs.payment_reused');
		});
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		expect(v.target.querySelector('[data-testid="chat-leg-wallet-confirm"]')).toBeNull();
		// Its receipt card does not show it arriving either; it is not checked.
		await v.settle();
		expect(paymentCheckAsks).toHaveLength(0);
		expect(v.target.querySelector('[data-testid="payment-check"]')).toBeNull();
	});

	it('the same payment recorded again for this order (its Monero key added) is checked as such', async () => {
		paymentCheckAnswer = found('0.05', 0);
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push([
			await addressMsg(1),
			await receiptMsg(txidN(9), { id: 2, key: false }),
			await receiptMsg(txidN(9), { id: 3, at: '2026-10-26T18:10:00Z' })
		]);
		await vi.waitFor(() => {
			v.flushSync();
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		});
	});

	it('Bitcoin at 0 confirmations: "Send BLURT", with a word that it can still be replaced', async () => {
		const { encodeAddressPayload, encodeFundsSentPayload } = await import('$lib/chat/payload');
		const BTC = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
		const at0 = (conf: number) => ({
			...found('0.001', conf, conf === 0 ? '' : '2026-10-26T18:04:00Z'),
			data: {
				...found('0.001', conf).data,
				asset: 'btc',
				tx_time: conf === 0 ? null : '2026-10-26T18:04:00Z'
			}
		});
		paymentCheckAnswer = at0(0);
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push([
			{
				id: 1,
				sender: ME,
				createdAt: new Date('2026-10-26T18:00:00Z'),
				text: encodeAddressPayload({
					v: 1,
					kind: 'morphit_addr',
					method: 'btc',
					address: BTC,
					amount: '0.001',
					orderPermlink: ORDER
				})
			},
			{
				id: 2,
				sender: PEER,
				createdAt: new Date('2026-10-26T18:05:00Z'),
				text: encodeFundsSentPayload({
					v: 1,
					kind: 'morphit_funds_sent',
					method: 'btc',
					txid: txidN(13),
					orderPermlink: ORDER
				})
			}
		]);
		await vi.waitFor(() => {
			v.flushSync();
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		});
		expect(
			v.target.querySelector('[data-testid="chat-leg-unconfirmed"]')?.textContent?.trim()
		).toBe('chat.legs.unconfirmed_btc');
	});

	it('the same address posted again later: the payment is dated against its FIRST share', async () => {
		paymentCheckAnswer = found('0.05', 3, '2026-10-26T18:04:00Z');
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push([
			await addressMsg(1),
			{ ...(await addressMsg(2)), createdAt: new Date('2026-10-26T21:00:00Z') },
			await receiptMsg(txidN(12), { id: 3, at: '2026-10-26T21:05:00Z' })
		]);
		await vi.waitFor(() => {
			v.flushSync();
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		});
	});

	it('mined but undated (no explorer gave its block time): not seen yet', async () => {
		paymentCheckAnswer = { ...found('0.05', 3), data: { ...found('0.05', 3).data, tx_time: null } };
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push(await msgs(txidN(10)));
		await vi.waitFor(() => {
			v.flushSync();
			expect(paymentCheckAsks.length).toBeGreaterThan(0);
		});
		await v.settle();
		expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		expect(hint(v)).toBe('chat.legs.checking_payment');
		// …and the receipt does not show it green (or "confirmed") meanwhile.
		expect(v.target.querySelector('[data-testid="payment-check"]')?.textContent?.trim()).toBe(
			'chat.payment_check.checking'
		);
	});

	describe('buying XMR with BLURT (the seller is paid in BLURT first)', () => {
		const txid = 'd'.repeat(40);
		const thread = async (askAmount: string | undefined, askedTo = ME, buyerSaidWhere = true) => {
			const { encodeAddressPayload, encodeFundsSentPayload } = await import('$lib/chat/payload');
			// Where the buyer wants his XMR.
			const where = {
				id: 3,
				sender: PEER,
				createdAt: new Date('2026-10-26T18:06:00Z'),
				text: encodeAddressPayload({
					v: 1,
					kind: 'morphit_addr',
					method: 'xmr',
					address: XMR_ADDR,
					orderPermlink: ORDER
				})
			};
			return [
				{
					id: 1,
					sender: ME,
					createdAt: new Date('2026-10-26T18:00:00Z'),
					text: encodeAddressPayload({
						v: 1,
						kind: 'morphit_addr',
						method: 'blurt',
						address: askedTo,
						...(askAmount !== undefined ? { amount: askAmount } : {}),
						memo: 'k7m2q9xa',
						orderPermlink: ORDER
					})
				},
				{
					id: 2,
					sender: PEER,
					createdAt: new Date('2026-10-26T18:05:00Z'),
					text: encodeFundsSentPayload({
						v: 1,
						kind: 'morphit_funds_sent',
						method: 'blurt',
						txid,
						orderPermlink: ORDER
					})
				},
				...(buyerSaidWhere ? [where] : [])
			];
		};
		beforeEach(() => {
			orderMethods = ['pay_blurt'];
			blurtChain.asks.length = 0;
		});
		afterEach(() => {
			blurtChain.answer = { kind: 'not_found' };
		});
		it('first he asks for BLURT', async () => {
			const v = await render(PEER, 'buy', 'XMR');
			expect(has(v, 'chat.legs.ask_blurt_aria')).toBe(true);
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(false);
		});
		it('paid as asked (checked against HIS ask in this chat, from this buyer): "Send XMR"', async () => {
			blurtChain.answer = { kind: 'verified' };
			const v = await render(PEER, 'buy', 'XMR');
			await v.push(await thread('500'));
			await vi.waitFor(() => {
				v.flushSync();
				expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
			});
			expect(blurtChain.asks[0]).toEqual({
				txid,
				recipient: ME,
				sender: PEER,
				amountBlurt: 500,
				memo: 'k7m2q9xa'
			});
		});
		it('paid more than asked (every other field right): paid', async () => {
			// The chain: 600 arrived, with his memo — so asked again with 600,
			// it is verified.
			blurtChain.answer = (expect) =>
				expect.amountBlurt === 600
					? { kind: 'verified' }
					: { kind: 'mismatch', field: 'amount', received: '600.000' };
			const v = await render(PEER, 'buy', 'XMR');
			await v.push(await thread('500'));
			await vi.waitFor(() => {
				v.flushSync();
				expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
			});
		});
		it('a BLURT txid already cited for another order: "reused", and the chain is not asked', async () => {
			blurtChain.answer = { kind: 'verified' };
			const { encodeFundsSentPayload } = await import('$lib/chat/payload');
			const v = await render(PEER, 'buy', 'XMR');
			await v.push([
				{
					id: 9,
					sender: PEER,
					createdAt: new Date('2026-10-26T17:00:00Z'),
					text: encodeFundsSentPayload({
						v: 1,
						kind: 'morphit_funds_sent',
						method: 'blurt',
						txid,
						orderPermlink: 'order-other'
					})
				},
				...(await thread('500'))
			]);
			await vi.waitFor(() => {
				v.flushSync();
				expect(hint(v)).toBe('chat.legs.payment_reused');
			});
			await v.settle();
			expect(blurtChain.asks).toHaveLength(0);
			expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		});
		it('paid, but the buyer has not said where he wants the XMR: no "Send XMR", and he is told so', async () => {
			blurtChain.answer = { kind: 'verified' };
			const v = await render(PEER, 'buy', 'XMR');
			await v.push(await thread('500', ME, false));
			await vi.waitFor(() => {
				v.flushSync();
				expect(hint(v)).toBe('chat.legs.waiting_asset_address');
			});
			expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
			await v.push(await thread('500'));
			await vi.waitFor(() => {
				v.flushSync();
				expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
			});
		});
		it('his XMR recorded with "Mark sent" but the receipt failed to post: "Send XMR" does not come back', async () => {
			blurtChain.answer = { kind: 'verified' };
			ctl.outcome = { ok: false, error: 'chain_unreachable' };
			const v = await render(PEER, 'buy', 'XMR');
			await v.push(await thread('500'));
			await vi.waitFor(() => {
				v.flushSync();
				expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
			});
			v.button((b) =>
				(b.getAttribute('aria-label') ?? '').startsWith('chat.funds_sent.button_aria_asset')
			)!.click();
			v.flushSync();
			const input = v.target.querySelector(
				'input[placeholder="chat.funds_sent.txid_placeholder"]'
			) as HTMLInputElement;
			input.value = 'e'.repeat(64);
			input.dispatchEvent(new Event('input', { bubbles: true }));
			v.flushSync();
			v.button((b) => (b.textContent ?? '').trim() === 'chat.funds_sent.send')!.click();
			await v.settle();
			expect(ctl.sent).toHaveLength(1);
			v.button((b) => (b.textContent ?? '').trim() === 'common.cancel')!.click();
			await v.settle();
			expect(has(v, 'chat.funds_sent.button_aria')).toBe(false);
		});
		it('paid less: no "Send XMR" unless his wallet says otherwise', async () => {
			blurtChain.answer = { kind: 'mismatch', field: 'amount', received: '0.001' };
			const v = await render(PEER, 'buy', 'XMR');
			await v.push(await thread('500'));
			await vi.waitFor(() => {
				v.flushSync();
				expect(hint(v)).toBe('chat.legs.payment_short');
			});
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(false);
		});
		it('an "ask" from the buyer is not the seller’s ask', async () => {
			blurtChain.answer = { kind: 'verified' };
			const { encodeAddressPayload } = await import('$lib/chat/payload');
			const v = await render(PEER, 'buy', 'XMR');
			const [, receipt] = await thread('500');
			await v.push([
				{
					id: 1,
					sender: PEER,
					createdAt: new Date('2026-10-26T18:00:00Z'),
					text: encodeAddressPayload({
						v: 1,
						kind: 'morphit_addr',
						method: 'blurt',
						address: ME,
						amount: '0.001',
						orderPermlink: ORDER
					})
				},
				receipt!
			]);
			await vi.waitFor(() => {
				v.flushSync();
				expect(hint(v)).toBe('chat.legs.payment_no_address');
			});
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(false);
			expect(blurtChain.asks).toHaveLength(0);
		});
		it('no amount asked: his call on the amount first', async () => {
			blurtChain.answer = { kind: 'verified' };
			const v = await render(PEER, 'buy', 'XMR');
			await v.push(await thread(undefined));
			await vi.waitFor(() => {
				v.flushSync();
				expect(hint(v)).toBe('chat.legs.check_amount');
			});
			const confirm = v.target.querySelector<HTMLButtonElement>(
				'[data-testid="chat-leg-wallet-confirm"]'
			);
			expect(confirm?.textContent?.trim()).toBe('chat.legs.amount_confirm');
			confirm!.click();
			v.flushSync();
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		});
		it('paid to another account he named: checked against that account', async () => {
			blurtChain.answer = { kind: 'verified' };
			const v = await render(PEER, 'buy', 'XMR');
			await v.push(await thread('500', 'alice-savings'));
			await vi.waitFor(() => {
				v.flushSync();
				expect(blurtChain.asks[0]).toMatchObject({ recipient: 'alice-savings' });
			});
		});
	});

	it('while the order cannot be read: no "Pay now" from an untagged address card', async () => {
		const { encodeAddressPayload } = await import('$lib/chat/payload');
		const v = await render(PEER, 'buy', 'BLURT', 1_000);
		await v.push([
			{
				id: 1,
				sender: PEER,
				orderPermlink: null,
				createdAt: new Date('2026-10-26T18:00:00Z'),
				text: encodeAddressPayload({
					v: 1,
					kind: 'morphit_addr',
					method: 'blurt',
					address: PEER,
					amount: '10'
				})
			}
		]);
		await v.settle();
		expect(
			[...v.target.querySelectorAll('button')].some(
				(b) => (b.textContent ?? '').trim() === 'chat.address.pay_now'
			)
		).toBe(false);
	});

	it('a finished crypto-for-crypto order: no "Pay now" from an address card either', async () => {
		orderStatus = 'completed';
		const { encodeAddressPayload } = await import('$lib/chat/payload');
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push([
			{
				id: 1,
				sender: PEER,
				createdAt: new Date('2026-10-26T18:00:00Z'),
				text: encodeAddressPayload({
					v: 1,
					kind: 'morphit_addr',
					method: 'blurt',
					address: PEER,
					amount: '10',
					orderPermlink: ORDER
				})
			}
		]);
		await v.settle();
		expect(
			[...v.target.querySelectorAll('button')].some(
				(b) => (b.textContent ?? '').trim() === 'chat.address.pay_now'
			)
		).toBe(false);
	});

	it('the buyer’s BLURT address card offers no "Pay now" to the seller before he is paid', async () => {
		const { encodeAddressPayload } = await import('$lib/chat/payload');
		const card = {
			id: 1,
			sender: PEER,
			createdAt: new Date('2026-10-26T18:00:00Z'),
			text: encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'blurt',
				address: PEER,
				amount: '10',
				orderPermlink: ORDER
			})
		};
		const v = await render(PEER, 'buy', 'BLURT');
		await v.push([card]);
		await v.settle();
		const payNow = () =>
			[...v.target.querySelectorAll('button')].some(
				(b) => (b.textContent ?? '').trim() === 'chat.address.pay_now'
			);
		expect(payNow()).toBe(false);
		// Once paid (seen in full), the card may pay as the toolbar does.
		paymentCheckAnswer = found('0.05', 0);
		await v.push([card, await addressMsg(2), await receiptMsg(txidN(11), { id: 3 })]);
		await vi.waitFor(() => {
			v.flushSync();
			expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		});
		expect(payNow()).toBe(true);
	});

	it('the buyer can record his payment again (a typo, the Monero key left out): "Mark sent" stays on the seller’s address card', async () => {
		const { encodeAddressPayload, encodeFundsSentPayload } = await import('$lib/chat/payload');
		const { recordFundsSent } = await import('$lib/trades/tradeStatus');
		// ME buys BLURT with XMR (my order); PEER, the seller, asked for XMR.
		const v = await render(ME, 'buy', 'BLURT');
		recordFundsSent({
			orderOwner: ME,
			orderPermlink: ORDER,
			peer: PEER,
			method: 'xmr',
			txid: txidN(12),
			direction: 'outgoing'
		});
		await v.push([
			{
				id: 1,
				sender: PEER,
				createdAt: new Date('2026-10-26T18:00:00Z'),
				text: encodeAddressPayload({
					v: 1,
					kind: 'morphit_addr',
					method: 'xmr',
					address: XMR_ADDR,
					amount: '0.05',
					orderPermlink: ORDER
				})
			},
			{
				id: 2,
				sender: ME,
				createdAt: new Date('2026-10-26T18:05:00Z'),
				text: encodeFundsSentPayload({
					v: 1,
					kind: 'morphit_funds_sent',
					method: 'xmr',
					txid: txidN(12),
					orderPermlink: ORDER
				})
			}
		]);
		await v.settle();
		const markSent = v.button((b) => (b.textContent ?? '').trim() === 'chat.address.mark_sent');
		expect(markSent).toBeDefined();
		markSent!.click();
		v.flushSync();
		expect(
			v.target.querySelector('input[placeholder="chat.funds_sent.txid_placeholder"]')
		).not.toBeNull();
	});

	it('a receipt too long for one chat message (a Monero key in many parts) is refused before sending, saying why', async () => {
		const { encodeAddressPayload } = await import('$lib/chat/payload');
		const v = await render(ME, 'buy', 'BLURT');
		await v.push([
			{
				id: 1,
				sender: PEER,
				createdAt: new Date('2026-10-26T18:00:00Z'),
				text: encodeAddressPayload({
					v: 1,
					kind: 'morphit_addr',
					method: 'xmr',
					address: XMR_ADDR,
					amount: '0.05',
					orderPermlink: ORDER
				})
			}
		]);
		await v.settle();
		v.button((b) => (b.textContent ?? '').trim() === 'chat.address.mark_sent')!.click();
		v.flushSync();
		const type = (placeholder: string, value: string) => {
			const input = v.target.querySelector(
				`input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`
			) as HTMLInputElement;
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			v.flushSync();
		};
		type('chat.funds_sent.txid_placeholder', txidN(14));
		type('chat.funds_sent.tx_key_placeholder', 'a'.repeat(64 * 17));
		v.button((b) => (b.textContent ?? '').trim() === 'chat.funds_sent.send')!.click();
		await v.settle();
		expect(ctl.sent).toHaveLength(0);
		expect(v.target.textContent).toContain('chat.funds_sent.too_long_to_send');
	});

	it('the buyer never gets "Share your Blurt account"; he waits for the seller’s address', async () => {
		const v = await render(ME, 'buy', 'BLURT');
		expect(has(v, 'chat.address.share_button')).toBe(false);
		expect(has(v, 'chat.funds_sent.button')).toBe(false);
		expect(hint(v)).toBe('chat.legs.waiting_address');
	});

	it('an order paid by PayPal keeps the one-leg buttons', async () => {
		orderMethods = ['paypal'];
		const v = await render(PEER, 'buy', 'BLURT');
		expect(has(v, 'chat.funds_sent.button_aria_asset')).toBe(true);
		expect(hint(v)).toBe('');
	});
});

describe('v1.21.17: the chain read marker follows what is seen during the visit', () => {
	// Before: one chain ack per visit, at open. Messages seen while the chat was
	// open were never acked on chain, so the relay sent an offline notice for
	// them 10–60 min later ("someone sent you a chat message" — nothing new).
	const setHidden = (hidden: boolean): void => {
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
		document.dispatchEvent(new Event('visibilitychange'));
	};
	const ackTimes = (): string[] => chainAcks.map((a) => (a[3] as Date).toISOString());
	const t = (iso: string) => ({ createdAt: new Date(iso) });
	/** Fake timers from here on: render() waits for the view with real ones
	 *  (vi.waitFor drives fake timers itself). Advanced synchronously below:
	 *  the async advance never returned here (CPU-bound in the timer loop). */
	const fakeTimers = (): void => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	};
	afterEach(() => {
		setHidden(false);
		vi.useRealTimers();
	});

	it('a message seen while the chat is open is acked on chain within five minutes, several in one ack', async () => {
		const v = await render(PEER, 'sell');
		fakeTimers();
		await v.push([t('2026-10-26T18:00:00Z')]);
		v.deps.onHistoryChange?.({ ready: true, loading: false, complete: false, failed: false });
		await v.settle();
		expect(ackTimes()).toEqual(['2026-10-26T18:00:00.000Z']);
		await v.push([t('2026-10-26T18:00:00Z'), t('2026-10-26T18:04:00Z')]);
		await v.push([t('2026-10-26T18:00:00Z'), t('2026-10-26T18:04:00Z'), t('2026-10-26T18:07:15Z')]);
		await v.settle();
		expect(ackTimes()).toHaveLength(1); // coalesced, not one op per message
		vi.advanceTimersByTime(5 * 60_000);
		await v.settle();
		expect(ackTimes()).toEqual(['2026-10-26T18:00:00.000Z', '2026-10-26T18:07:15.000Z']);
	});

	it('after a failed ack, the next messages are not each broadcast: one retry every five minutes', async () => {
		chainAckFailures.left = 1;
		const v = await render(PEER, 'sell');
		fakeTimers();
		await v.push([t('2026-10-26T18:00:00Z')]);
		v.deps.onHistoryChange?.({ ready: true, loading: false, complete: false, failed: false });
		await v.settle();
		expect(chainAcks).toHaveLength(1); // tried, and failed
		await v.push([t('2026-10-26T18:00:00Z'), t('2026-10-26T18:01:00Z')]);
		await v.settle();
		await v.push([t('2026-10-26T18:00:00Z'), t('2026-10-26T18:01:00Z'), t('2026-10-26T18:02:00Z')]);
		await v.settle();
		expect(chainAcks).toHaveLength(1);
		vi.advanceTimersByTime(5 * 60_000);
		await v.settle();
		expect(ackTimes()).toEqual(['2026-10-26T18:00:00.000Z', '2026-10-26T18:02:00.000Z']);
	});

	it('closing the chat while the tab is hidden does not ack what arrived unseen', async () => {
		const v = await render(PEER, 'sell');
		fakeTimers();
		await v.push([t('2026-10-26T18:00:00Z')]);
		v.deps.onHistoryChange?.({ ready: true, loading: false, complete: false, failed: false });
		await v.settle();
		setHidden(true);
		await v.push([t('2026-10-26T18:00:00Z'), t('2026-10-26T18:09:00Z')]);
		v.destroy();
		await v.settle();
		expect(ackTimes()).toEqual(['2026-10-26T18:00:00.000Z']);
	});

	it('closing the chat sends what was seen at once', async () => {
		const v = await render(PEER, 'sell');
		fakeTimers();
		await v.push([t('2026-10-26T18:00:00Z')]);
		v.deps.onHistoryChange?.({ ready: true, loading: false, complete: false, failed: false });
		await v.settle();
		await v.push([t('2026-10-26T18:00:00Z'), t('2026-10-26T18:07:15Z')]);
		v.destroy();
		await v.settle();
		expect(ackTimes()).toEqual(['2026-10-26T18:00:00.000Z', '2026-10-26T18:07:15.000Z']);
	});

	it('hiding the tab sends what was seen at once; what arrives while hidden waits until shown', async () => {
		const v = await render(PEER, 'sell');
		fakeTimers();
		await v.push([t('2026-10-26T18:00:00Z')]);
		v.deps.onHistoryChange?.({ ready: true, loading: false, complete: false, failed: false });
		await v.settle();
		await v.push([t('2026-10-26T18:00:00Z'), t('2026-10-26T18:04:00Z')]);
		setHidden(true);
		await v.settle();
		expect(ackTimes()).toEqual(['2026-10-26T18:00:00.000Z', '2026-10-26T18:04:00.000Z']);
		// Arrives while hidden: not seen, so not acked, not even after five minutes.
		await v.push([t('2026-10-26T18:00:00Z'), t('2026-10-26T18:04:00Z'), t('2026-10-26T18:09:00Z')]);
		vi.advanceTimersByTime(120_000);
		await v.settle();
		expect(ackTimes()).toHaveLength(2);
		// Shown: acked within a minute.
		setHidden(false);
		vi.advanceTimersByTime(5 * 60_000);
		await v.settle();
		expect(ackTimes()).toEqual([
			'2026-10-26T18:00:00.000Z',
			'2026-10-26T18:04:00.000Z',
			'2026-10-26T18:09:00.000Z'
		]);
	});

	it('my own messages are never acked on chain: only the peer’s', async () => {
		const v = await render(PEER, 'sell');
		fakeTimers();
		await v.push([t('2026-10-26T18:00:00Z')]);
		v.deps.onHistoryChange?.({ ready: true, loading: false, complete: false, failed: false });
		await v.settle();
		expect(ackTimes()).toEqual(['2026-10-26T18:00:00.000Z']);
		// I write twice; nothing new from the peer.
		await v.push([
			t('2026-10-26T18:00:00Z'),
			{ sender: ME, createdAt: new Date('2026-10-26T18:03:00Z') },
			{ sender: ME, createdAt: new Date('2026-10-26T18:06:00Z') }
		]);
		await v.settle();
		vi.advanceTimersByTime(5 * 60_000);
		await v.settle();
		setHidden(true);
		v.destroy();
		await v.settle();
		expect(ackTimes()).toEqual(['2026-10-26T18:00:00.000Z']);
	});

	it('a newer peer message is acked once, not again within five minutes', async () => {
		const v = await render(PEER, 'sell');
		fakeTimers();
		await v.push([t('2026-10-26T18:00:00Z')]);
		v.deps.onHistoryChange?.({ ready: true, loading: false, complete: false, failed: false });
		await v.settle();
		await v.push([t('2026-10-26T18:00:00Z'), t('2026-10-26T18:01:00Z')]);
		await v.settle();
		vi.advanceTimersByTime(4 * 60_000);
		await v.settle();
		expect(ackTimes()).toEqual(['2026-10-26T18:00:00.000Z']);
		vi.advanceTimersByTime(60_000);
		await v.settle();
		expect(ackTimes()).toEqual(['2026-10-26T18:00:00.000Z', '2026-10-26T18:01:00.000Z']);
	});

	it('opening the thread again in this tab does not ack again what was acked', async () => {
		const v = await render(PEER, 'sell');
		await v.push([t('2026-10-26T18:00:00Z')]);
		v.deps.onHistoryChange?.({ ready: true, loading: false, complete: false, failed: false });
		await v.settle();
		await vi.waitFor(() => expect(chainAcks).toHaveLength(1));
		await v.settle();
		v.destroy();
		const again = await render(PEER, 'sell');
		await again.push([t('2026-10-26T18:00:00Z')]);
		again.deps.onHistoryChange?.({ ready: true, loading: false, complete: false, failed: false });
		await again.settle();
		again.destroy();
		await again.settle();
		expect(chainAcks).toHaveLength(1);
	});
});

describe('review C, M3: a fast copy read here stays read when its chain copy lands', () => {
	it('the view marks an ack of a fast copy as such, so the durable row does not relight the thread', async () => {
		const { isUnread, clearReadState } = await import('$lib/chat/readState');
		clearReadState();
		const v = await render(PEER, 'sell');
		// The newest message is a fast copy (no chain copy yet), dated with the
		// head time its sender signed at.
		await v.push([
			{ createdAt: new Date('2026-10-21T11:00:00Z') },
			{ id: null, createdAt: new Date('2026-10-21T12:00:00Z'), provisionalSinceMs: Date.now() }
		]);
		// The chain copy lands in a block three seconds later.
		expect(isUnread(PEER, ORDER, '2026-10-21T12:00:03.000Z', false)).toBe(false);
	});
	it('a durable newest message covers nothing after it', async () => {
		const { isUnread, clearReadState } = await import('$lib/chat/readState');
		clearReadState();
		const v = await render(PEER, 'sell');
		await v.push([{ createdAt: new Date('2026-10-21T12:00:00Z') }]);
		expect(isUnread(PEER, ORDER, '2026-10-21T12:00:03.000Z', false)).toBe(true);
	});
});

describe('W-M2: Verify peer from a refused message', () => {
	it('opens the panel; accepting there sends the message again', async () => {
		const v = await render(PEER, 'sell');
		await v.push([
			{ sender: ME, state: 'failed', error: 'pub_pin_key_changed', localSeq: 9, text: 'hello' }
		]);
		v.button((b) => (b.textContent ?? '').includes('chat.menu.verify_peer'))!.click();
		v.flushSync();
		expect(panel.props).not.toBeNull();
		expect(panel.props!.peerWritesPostingFormat).toBeUndefined();
		expect(ctl.retried).toEqual([]);
		(panel.props!.onAccepted as () => void)();
		expect(ctl.retried).toEqual([9]);
	});

	it('opened from the menu: accepting retries nothing', async () => {
		const v = await render(PEER, 'sell');
		// A refused message's Verify peer was opened first: the menu's later
		// opening must not inherit that message's retry.
		await v.push([
			{ sender: ME, state: 'failed', error: 'pub_pin_key_changed', localSeq: 9, text: 'hello' }
		]);
		v.button(
			(b) =>
				(b.textContent ?? '').includes('chat.menu.verify_peer') &&
				b.getAttribute('role') !== 'menuitem'
		)!.click();
		v.flushSync();
		v.button(
			(b) =>
				b.getAttribute('aria-haspopup') === 'menu' ||
				(b.getAttribute('aria-label') ?? '').includes('overflow')
		)?.click();
		v.flushSync();
		const item = v.button(
			(b) =>
				(b.textContent ?? '').includes('chat.menu.verify_peer') &&
				b.getAttribute('role') === 'menuitem'
		);
		expect(item).toBeDefined();
		item!.click();
		v.flushSync();
		(panel.props!.onAccepted as () => void)();
		expect(ctl.retried).toEqual([]);
	});
});

describe('W-L6 / W-L7: the thread’s order reaches the bubbles and the composer', () => {
	it('the owner’s "settled with another trader" notice shows; the draft is keyed by the thread', async () => {
		const { encodeOrderSettledElsewherePayload } = await import('$lib/chat/payload');
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const v = await render(PEER, 'sell');
			await v.push([
				{
					text: encodeOrderSettledElsewherePayload({
						v: 1,
						kind: 'morphit_order_settled_elsewhere',
						orderPermlink: ORDER
					})
				}
			]);
			expect(v.target.textContent).toContain('chat.system.order_settled_elsewhere');
			const box = v.target.querySelector('textarea[name="chat-message"]') as HTMLTextAreaElement;
			box.value = 'about this order';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			v.flushSync();
			await vi.advanceTimersByTimeAsync(600);
			expect(localStorage.getItem(`morphit.draft.chat.${PEER}#${ORDER}`)).not.toBeNull();
			expect(localStorage.getItem(`morphit.draft.chat.${PEER}`)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
