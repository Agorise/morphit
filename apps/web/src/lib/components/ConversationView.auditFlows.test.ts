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
vi.mock('$blurt/ops/chatRead', () => ({
	broadcastChatRead: async (...a: unknown[]) => {
		chainAcks.push(a);
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
	getFeedbackGiven: async () => ({ ok: false, error: { code: 'x', message: 'x' } })
}));

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
		payment_methods: ['paypal'],
		price_model: { kind: 'fixed', price: 1 },
		location_region: null,
		accepted_assets: null,
		specific_barter_title: null,
		terms: null,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		expires_at: null,
		status: 'live'
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
	document.body.innerHTML = '';
	served = null;
	orderReadsFailing = 0;
	ctl.outcome = { ok: true };
	ctl.retried.length = 0;
	ctl.sent.length = 0;
	toasts.length = 0;
	chainAcks.length = 0;
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
