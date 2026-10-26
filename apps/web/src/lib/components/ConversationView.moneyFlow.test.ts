// @vitest-environment jsdom
/**
 * The chat's money-flow button row, rendered by the REAL ConversationView.
 *
 * orderRole.test.ts proves the pure helpers; this proves the view wires them:
 * that it hands chatMoneyFlow the order's asset (a BARTER order stores the
 * GOODS direction, the inverse of the crypto one), takes orderCanShip from
 * orderRole (a barter listing's methods are only `pay_<coin>` rails), and
 * splits the physical controls by crypto direction (the crypto receiver ships,
 * the crypto sender shares a mailing address). Reverting any of those in the
 * view leaves every pure test green, so the row itself is asserted here. It
 * also pins when the row goes away (a finished order, a payment receipt on
 * either side, a locked session) and that a shared address alone does not.
 *
 * Buttons are told apart by their aria-label i18n keys (`_` is the identity,
 * with the values appended), matched by prefix: a crypto order's buttons carry
 * the coin-named keys (`…_aria_asset`, `…_aria_blurt`), a barter order's the
 * generic ones. The labels themselves, and the RE: line read from the reader's
 * side, are pinned in the last block.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
	// The identity, plus the values when there are any, so a coin-named label
	// ("Send {asset}") shows which coin it was given.
	_: readable((k: string, o?: { values?: Record<string, unknown> }) =>
		o?.values ? `${k}${JSON.stringify(o.values)}` : k
	),
	locale: readable('en')
}));
/** Whether the session is unlocked when the view mounts (read at subscribe). */
let unlocked = true;
vi.mock('$stores/identity', () => ({
	liveIdentity: readable(null),
	isUnlocked: {
		subscribe: (run: (v: boolean) => void) => {
			run(unlocked);
			return () => {};
		}
	},
	isPairedReadOnly: readable(false)
}));
vi.mock('$lib/chat/chatService', () => ({
	CHAT_CONSTANTS: { ENCRYPTED_PLACEHOLDER: '' },
	runtimeDeps: () => ({}),
	createConversationController: () => ({
		start: () => {},
		destroy: () => {},
		sendMessage: async () => {},
		retryMessage: async () => {}
	})
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

/** The order the stubbed indexer serves, and whose book it is in. */
let served: { owner: string; item: Record<string, unknown> } | null = null;
vi.mock('$lib/indexer/client', () => ({
	getChatAdmission: async (me: string, peer: string) => ({
		ok: true,
		data: { me, peer, admitted: true, reason: 'prior_contact' }
	}),
	getOrder: async (owner: string) =>
		served !== null && owner === served.owner
			? { ok: true, data: { item: served.item } }
			: { ok: false, code: 'not_found', message: 'x' },
	getReputationReceipt: async () => ({ ok: false, error: { code: 'x', message: 'x' } }),
	getFeedbackGiven: async () => ({ ok: false, error: { code: 'x', message: 'x' } })
}));

const ME = 'alice';
const PEER = 'bob';
const PERMLINK = 'bananas-for-coins';

const BUTTONS = {
	payNow: 'chat.funds_sent.button_aria',
	shareAddress: 'chat.address.share_button_aria',
	shareMailing: 'chat.mailing_address.button_aria',
	recordShipment: 'chat.shipment.button_aria'
} as const;
type Row = Record<keyof typeof BUTTONS, boolean>;
/** What the last renderRow showed: each present button's text and aria-label,
 *  and the RE: line's text. */
let lastRender: {
	labels: Partial<Record<keyof typeof BUTTONS, { text: string; aria: string | null }>>;
	re: string;
	/** which payment window the "Send …" click opened (when clicked) */
	dialog: 'pay-blurt' | 'funds-sent' | null;
} = { labels: {}, re: '', dialog: null };

afterEach(() => {
	document.body.innerHTML = '';
	served = null;
	unlocked = true;
});

function orderItem(o: {
	side: 'buy' | 'sell';
	asset: string;
	payment_methods: string[];
	status?: string;
	accepted_assets?: string[] | null;
}): Record<string, unknown> {
	return {
		account: 'x',
		permlink: PERMLINK,
		fiat_currency: 'MXN',
		amount_min: 100,
		amount_max: 500,
		price_model: { kind: 'fixed', price: 1 },
		location_region: null,
		accepted_assets: null,
		specific_barter_title: null,
		terms: null,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		expires_at: null,
		status: 'live',
		...o
	};
}

async function renderRow(
	owner: string,
	item: Record<string, unknown>,
	opts: {
		/** a funds-sent receipt for this order: sent by me, or received from the peer */
		paid?: 'outgoing' | 'incoming';
		/** a crypto address shared for this order (the step before paying) */
		addressShared?: 'outgoing' | 'incoming';
		locked?: boolean;
		/** click the "Send …" button and record which payment window opened */
		clickPayNow?: boolean;
	} = {}
): Promise<Row> {
	served = { owner, item: { ...item, account: owner } };
	unlocked = !opts.locked;
	const { mount, flushSync, unmount } = await import('svelte');
	const { clearAllTradeStates, recordAddressShared, recordFundsSent } = await import(
		'$lib/trades/tradeStatus'
	);
	clearAllTradeStates();
	if (opts.addressShared) {
		recordAddressShared({
			orderOwner: owner,
			orderPermlink: PERMLINK,
			peer: PEER,
			method: 'xmr',
			address: '4' + 'a'.repeat(94),
			direction: opts.addressShared
		});
	}
	if (opts.paid) {
		recordFundsSent({
			orderOwner: owner,
			orderPermlink: PERMLINK,
			peer: PEER,
			method: 'xmr',
			txid: 'a'.repeat(64),
			direction: opts.paid
		});
	}
	const { default: ConversationView } = await import('./ConversationView.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	const app = mount(ConversationView, {
		target,
		props: { me: ME, peer: PEER, orderPermlink: PERMLINK }
	});
	// The order and the admission resolve asynchronously; the RE: line (the
	// order summary) and the composer show once both have landed.
	await vi.waitFor(() => {
		flushSync();
		expect(target.textContent).toMatch(/order_title(_3p)?\./);
		expect(target.querySelector('textarea')).not.toBeNull();
	});
	flushSync();
	const buttons = Object.entries(BUTTONS).map(
		([k, aria]) =>
			[k, target.querySelector<HTMLButtonElement>(`button[aria-label^="${aria}"]`)] as const
	);
	const row = Object.fromEntries(buttons.map(([k, b]) => [k, b !== null])) as Row;
	let dialog: 'pay-blurt' | 'funds-sent' | null = null;
	if (opts.clickPayNow) {
		buttons.find(([k]) => k === 'payNow')?.[1]?.click();
		flushSync();
		dialog = target.querySelector('[aria-labelledby="pay-blurt-heading"]')
			? 'pay-blurt'
			: target.querySelector('[aria-labelledby="funds-sent-heading"]')
				? 'funds-sent'
				: null;
	}
	const reLink = target.querySelector<HTMLElement>('[data-testid="chat-order-ref"]');
	lastRender = {
		labels: Object.fromEntries(
			buttons.flatMap(([k, b]) =>
				b ? [[k, { text: (b.textContent ?? '').trim(), aria: b.getAttribute('aria-label') }]] : []
			)
		),
		re: (reLink?.textContent ?? '').replace(/\s+/g, ' ').trim(),
		dialog
	};
	unmount(app);
	return row;
}

const none: Row = {
	payNow: false,
	shareAddress: false,
	shareMailing: false,
	recordShipment: false
};
const goodsBuyer: Row = { ...none, payNow: true, shareMailing: true };
const goodsSeller: Row = { ...none, shareAddress: true, recordShipment: true };

const barter = (side: 'buy' | 'sell', status = 'live') =>
	orderItem({
		side,
		asset: 'BARTER',
		payment_methods: ['pay_xmr', 'pay_blurt'],
		accepted_assets: ['XMR', 'BLURT'],
		status
	});

// Compiling the chat component takes seconds (up to ~25 s measured on a loaded
// 2-CPU box): done once here, with room, so it never counts against a test.
beforeAll(async () => {
	await import('svelte');
	await import('$lib/trades/tradeStatus');
	await import('./ConversationView.svelte');
}, 120_000);

describe('ConversationView money-flow row on a BARTER order', () => {
	it("peer's goods-SELL listing: I am the goods buyer — Pay now + Share mailing address", async () => {
		expect(await renderRow(PEER, barter('sell'))).toEqual(goodsBuyer);
	});
	it('my goods-SELL listing: I am the goods seller — Share crypto address + Record shipment', async () => {
		expect(await renderRow(ME, barter('sell'))).toEqual(goodsSeller);
	});
	it("peer's goods-BUY listing: I am the goods seller", async () => {
		expect(await renderRow(PEER, barter('buy'))).toEqual(goodsSeller);
	});
	it('my goods-BUY listing: I am the goods buyer', async () => {
		expect(await renderRow(ME, barter('buy'))).toEqual(goodsBuyer);
	});
	it('a finished barter order shows no row', async () => {
		for (const status of ['completed', 'cancelled', 'expired']) {
			expect(await renderRow(PEER, barter('sell', status))).toEqual(none);
		}
	});
	it('once the payment receipt has landed the row is gone, for the payer and the paid', async () => {
		// I am the goods buyer and sent the payment.
		expect(await renderRow(PEER, barter('sell'), { paid: 'outgoing' })).toEqual(none);
		// I am the goods seller and the peer's receipt reached me.
		expect(await renderRow(ME, barter('sell'), { paid: 'incoming' })).toEqual(none);
	});
	it('a shared crypto address (the step before paying) keeps the row', async () => {
		expect(await renderRow(PEER, barter('sell'), { addressShared: 'incoming' })).toEqual(
			goodsBuyer
		);
		expect(await renderRow(ME, barter('sell'), { addressShared: 'outgoing' })).toEqual(goodsSeller);
	});
	it('a locked session shows no row', async () => {
		expect(await renderRow(PEER, barter('sell'), { locked: true })).toEqual(none);
	});
});

describe('ConversationView money-flow row on a crypto order (unchanged)', () => {
	it('peer sells XMR for PayPal: I receive crypto — Share crypto address only', async () => {
		const o = orderItem({ side: 'sell', asset: 'XMR', payment_methods: ['paypal'] });
		expect(await renderRow(PEER, o)).toEqual({ ...none, shareAddress: true });
	});
	it('peer buys XMR paying cash by mail: I send crypto and receive the cash — Pay now + Share mailing address', async () => {
		const o = orderItem({ side: 'buy', asset: 'XMR', payment_methods: ['cash_by_mail'] });
		expect(await renderRow(PEER, o)).toEqual(goodsBuyer);
	});
	it('my XMR buy paid by mail: I receive crypto and mail the cash — Share crypto address + Record shipment', async () => {
		const o = orderItem({ side: 'buy', asset: 'XMR', payment_methods: ['cash_by_mail'] });
		expect(await renderRow(ME, o)).toEqual(goodsSeller);
	});
});

describe('the row names the coin; the RE: line reads from the reader’s side (v1.21.16)', () => {
	it("peer buys BLURT: my button is “Send BLURT”, the RE: line is “Regarding @bob's order: Buying …”", async () => {
		const o = orderItem({ side: 'buy', asset: 'BLURT', payment_methods: ['bank_transfer'] });
		expect(await renderRow(PEER, o)).toEqual({ ...none, payNow: true });
		expect(lastRender.labels.payNow).toEqual({
			text: 'chat.funds_sent.button_asset{"asset":"BLURT"}',
			aria: 'chat.funds_sent.button_aria_asset{"asset":"BLURT"}'
		});
		expect(lastRender.re).toMatch(
			/^chat\.header\.re_peer\{"owner":"bob"\} order_title_3p\.buy_range/
		);
	});
	it('peer sells BLURT: my button shares my Blurt account', async () => {
		const o = orderItem({ side: 'sell', asset: 'BLURT', payment_methods: ['bank_transfer'] });
		expect(await renderRow(PEER, o)).toEqual({ ...none, shareAddress: true });
		expect(lastRender.labels.shareAddress).toEqual({
			text: 'chat.address.share_button_blurt',
			aria: 'chat.address.share_button_aria_blurt'
		});
	});
	it('peer sells XMR: my button shares my XMR address', async () => {
		const o = orderItem({ side: 'sell', asset: 'XMR', payment_methods: ['paypal'] });
		await renderRow(PEER, o);
		expect(lastRender.labels.shareAddress).toEqual({
			text: 'chat.address.share_button_asset{"asset":"XMR"}',
			aria: 'chat.address.share_button_aria_asset{"asset":"XMR"}'
		});
	});
	it('my own BLURT buy: the peer sends, I share my Blurt account; the RE: line is “Regarding my order: I’m buying …”', async () => {
		const o = orderItem({ side: 'buy', asset: 'BLURT', payment_methods: ['bank_transfer'] });
		expect(await renderRow(ME, o)).toEqual({ ...none, shareAddress: true });
		expect(lastRender.labels.shareAddress?.text).toBe('chat.address.share_button_blurt');
		expect(lastRender.re).toMatch(/^chat\.header\.re_mine order_title\.buy_range/);
	});
	it('a barter order that accepts one coin names it', async () => {
		const o = orderItem({
			side: 'sell',
			asset: 'BARTER',
			payment_methods: ['pay_xmr'],
			accepted_assets: ['XMR']
		});
		expect(await renderRow(PEER, o)).toEqual(goodsBuyer);
		expect(lastRender.labels.payNow?.text).toBe('chat.funds_sent.button_asset{"asset":"XMR"}');
	});
	it('“Send BLURT” sends BLURT from the app: a BLURT order and a barter order paid only in BLURT', async () => {
		const blurtOrder = orderItem({
			side: 'buy',
			asset: 'BLURT',
			payment_methods: ['bank_transfer']
		});
		await renderRow(PEER, blurtOrder, { clickPayNow: true });
		expect(lastRender.dialog).toBe('pay-blurt');
		const blurtBarter = orderItem({
			side: 'sell',
			asset: 'BARTER',
			payment_methods: ['pay_blurt'],
			accepted_assets: ['BLURT']
		});
		await renderRow(PEER, blurtBarter, { clickPayNow: true });
		expect(lastRender.labels.payNow?.text).toBe('chat.funds_sent.button_asset{"asset":"BLURT"}');
		expect(lastRender.dialog).toBe('pay-blurt');
	});
	it('“Send XMR” records an outside payment (XMR order, or a barter order paid only in XMR)', async () => {
		await renderRow(PEER, orderItem({ side: 'buy', asset: 'XMR', payment_methods: ['paypal'] }), {
			clickPayNow: true
		});
		expect(lastRender.dialog).toBe('funds-sent');
		await renderRow(
			PEER,
			orderItem({
				side: 'sell',
				asset: 'BARTER',
				payment_methods: ['pay_xmr'],
				accepted_assets: ['XMR']
			}),
			{ clickPayNow: true }
		);
		expect(lastRender.dialog).toBe('funds-sent');
	});
	it('a barter order (any of several coins) keeps the generic labels', async () => {
		await renderRow(PEER, barter('sell'));
		expect(lastRender.labels.payNow).toEqual({
			text: 'chat.funds_sent.button',
			aria: 'chat.funds_sent.button_aria'
		});
		await renderRow(ME, barter('sell'));
		expect(lastRender.labels.shareAddress).toEqual({
			text: 'chat.address.share_button',
			aria: 'chat.address.share_button_aria'
		});
	});
});
