// @vitest-environment jsdom
/**
 * The REAL ChatMessage bubble (v1.21.14 full chat audit):
 *
 *   W-H1  Pay now / Mark sent only on an address about THIS thread's order —
 *         paying one that names another order recorded the payment against
 *         that order and tied it to this peer; "already paid" is the trade
 *         with this bubble's sender, not anyone's;
 *   W-L6  the "settled with another trader" notice only for a proved message
 *         from the order's owner, about this thread's order;
 *   W-M2  a message refused over a changed key offers Verify peer (where the
 *         number is shown), never a one-tap accept of an unseen key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/stores', () => ({
	page: readable({
		params: { lang: 'en' },
		data: { lang: 'en' },
		url: new URL('https://m.example/en/chat/bob')
	})
}));
vi.mock('svelte-i18n', () => ({
	_: readable((k: string) => k),
	locale: readable('en'),
	date: readable(() => ''),
	time: readable(() => ''),
	number: readable((n: number) => String(n))
}));
vi.mock('$net/chainRelay', () => ({
	ChainRelayError: class extends Error {},
	chainRelay: async () => null
}));

import { encodeAddressPayload, encodeOrderSettledElsewherePayload } from '$lib/chat/payload';
import * as ts from '$lib/trades/tradeStatus';
import * as pin from '$lib/chat/pubPin';

const THREAD = 'bob-sells-blurt';

afterEach(() => {
	document.body.innerHTML = '';
});
beforeEach(() => {
	ts.clearAllTradeStates();
	localStorage.clear();
});

async function mount(props: Record<string, unknown>) {
	const { mount: m, flushSync } = await import('svelte');
	const { default: ChatMessage } = await import('$components/ChatMessage.svelte');
	const target = document.createElement('ul');
	document.body.append(target);
	m(ChatMessage, { target, props: props as never });
	flushSync();
	return target;
}
const msg = (over: Record<string, unknown>) => ({
	id: 1,
	clientTag: null,
	sender: 'bob',
	state: 'confirmed',
	createdAt: new Date('2026-10-21T12:00:00Z'),
	orderPermlink: THREAD,
	trxId: null,
	error: null,
	decryptFailed: false,
	localSeq: 7,
	...over
});
const button = (t: HTMLElement, key: string) =>
	[...t.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(key));
const addr = (order: string | undefined, method: 'blurt' | 'btc' = 'blurt') =>
	encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method,
		address: method === 'blurt' ? 'bob' : '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		amount: '5',
		...(order !== undefined ? { orderPermlink: order } : {})
	});

describe('W-H1: Pay now / Mark sent belong to this thread’s order', () => {
	it('an address about THIS order: Pay now, and it passes this order on', async () => {
		const paid: { orderPermlink?: string }[] = [];
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: msg({ text: addr(THREAD) }),
			onPayNow: (a: { orderPermlink?: string }) => paid.push(a)
		});
		button(t, 'chat.address.pay_now')!.click();
		expect(paid.map((p) => p.orderPermlink)).toEqual([THREAD]);
	});

	it('an address naming ANOTHER order: no Pay now', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: msg({ text: addr('carol-sells-blurt') }),
			onPayNow: () => undefined
		});
		expect(button(t, 'chat.address.pay_now')).toBeUndefined();
	});

	it('…and no Mark sent either', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: msg({ text: addr('carol-sells-blurt', 'btc') }),
			onMarkSent: () => undefined
		});
		expect(button(t, 'chat.address.mark_sent')).toBeUndefined();
		const own = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: msg({ text: addr(THREAD, 'btc'), localSeq: 8 }),
			onMarkSent: () => undefined
		});
		expect(button(own, 'chat.address.mark_sent')).toBeDefined();
	});

	it('another peer’s "paid" claim about the same order does not hide this one’s Pay now', async () => {
		ts.recordFundsSent({
			orderOwner: 'bob',
			orderPermlink: THREAD,
			peer: 'mallory',
			method: 'blurt',
			txid: 'a'.repeat(40),
			direction: 'incoming'
		});
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: msg({ text: addr(THREAD) }),
			onPayNow: () => undefined
		});
		expect(button(t, 'chat.address.pay_now')).toBeDefined();
		// The trade with THIS peer paid: hidden.
		ts.recordFundsSent({
			orderOwner: 'bob',
			orderPermlink: THREAD,
			peer: 'bob',
			method: 'blurt',
			txid: 'b'.repeat(40),
			direction: 'outgoing'
		});
		const { flushSync } = await import('svelte');
		flushSync();
		expect(button(t, 'chat.address.pay_now')).toBeUndefined();
	});
});

describe('C-L3: whose order it is unknown — no Pay now / Mark sent (fail closed)', () => {
	it('an order thread whose owner is not known yet: neither button', async () => {
		// Already paid, but under an owner this view has not resolved.
		ts.recordFundsSent({
			orderOwner: 'bob',
			orderPermlink: THREAD,
			peer: 'bob',
			method: 'blurt',
			txid: 'a'.repeat(40),
			direction: 'outgoing'
		});
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			message: msg({ text: addr(THREAD) }),
			onPayNow: () => undefined
		});
		expect(button(t, 'chat.address.pay_now')).toBeUndefined();
		const btc = await mount({
			me: 'alice',
			peer: 'bob',
			message: msg({ text: addr(THREAD, 'btc'), localSeq: 8 }),
			onMarkSent: () => undefined
		});
		expect(button(btc, 'chat.address.mark_sent')).toBeUndefined();
	});

	it('once known, the payment already made hides Pay now', async () => {
		ts.recordFundsSent({
			orderOwner: 'bob',
			orderPermlink: THREAD,
			peer: 'bob',
			method: 'blurt',
			txid: 'a'.repeat(40),
			direction: 'outgoing'
		});
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: msg({ text: addr(THREAD) }),
			onPayNow: () => undefined
		});
		expect(button(t, 'chat.address.pay_now')).toBeUndefined();
	});

	it('a direct message (no order thread): Pay now as before', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			message: msg({ text: addr(undefined), orderPermlink: null }),
			onPayNow: () => undefined
		});
		expect(button(t, 'chat.address.pay_now')).toBeDefined();
	});
});

describe('W-L6: "settled with another trader" speaks for the order’s owner only', () => {
	const settled = (order: string) =>
		encodeOrderSettledElsewherePayload({
			v: 1,
			kind: 'morphit_order_settled_elsewhere',
			orderPermlink: order
		});

	it('from the owner, about this thread’s order, proved: the notice', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: msg({ text: settled(THREAD) })
		});
		expect(t.textContent).toContain('chat.system.order_settled_elsewhere');
	});

	it('from someone who does not own the order: not the notice', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'alice',
			message: msg({ text: settled(THREAD) })
		});
		expect(t.textContent).not.toContain('chat.system.order_settled_elsewhere');
	});

	it('the owner not known (yet): not the notice', async () => {
		const t = await mount({ me: 'alice', peer: 'bob', message: msg({ text: settled(THREAD) }) });
		expect(t.textContent).not.toContain('chat.system.order_settled_elsewhere');
	});

	it('about another order than this thread’s: not the notice', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: msg({ text: settled('bob-sells-btc') })
		});
		expect(t.textContent).not.toContain('chat.system.order_settled_elsewhere');
	});

	it('an unproved sender: not the notice', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: msg({ text: settled(THREAD), senderUnverified: true })
		});
		expect(t.textContent).not.toContain('chat.system.order_settled_elsewhere');
	});
});

describe('W-M2: a changed key is accepted only in Verify peer', () => {
	for (const error of ['pub_pin_key_changed', 'pub_pin_posting_key_changed']) {
		it(`${error}: the bubble opens Verify peer for this message and accepts nothing itself`, async () => {
			pin.setPin('bob', { blockNum: 1, trxId: 'a'.repeat(40), pubB64: 'OLD' });
			localStorage.setItem(
				'morphit.chat.pub_pin_pending',
				JSON.stringify({ bob: { blockNum: 2, trxId: 'b'.repeat(40), pubB64: 'NEW' } })
			);
			const opened: number[] = [];
			const retried: number[] = [];
			const t = await mount({
				me: 'alice',
				peer: 'bob',
				message: msg({ sender: 'alice', state: 'failed', error, text: 'hi' }),
				onRetry: (s: number) => retried.push(s),
				onVerifyPeer: (s: number) => opened.push(s)
			});
			expect(button(t, 'chat.security.accept_new_key')).toBeUndefined();
			button(t, 'chat.menu.verify_peer')!.click();
			expect(opened).toEqual([7]);
			expect(retried).toEqual([]);
			expect(pin.getPin('bob')?.pubB64).toBe('OLD');
		});
	}
});

describe('W-M5: a message too long to deliver says so', () => {
	it('the bubble names the reason (it was not broadcast, so no fee)', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			message: msg({ sender: 'alice', state: 'failed', error: 'message_too_long', text: 'x' })
		});
		expect(t.textContent).toContain('chat.message.too_long');
	});
});

describe('posting-key-only chat (v1.21.14): the "not verified" note says which case it is', () => {
	it('an older-format message: the calm note, never the key-change warning', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			message: msg({ text: 'hello', senderUnverified: true, olderFormat: true })
		});
		const note = t.querySelector('[role="note"]')!;
		expect(note.textContent).toContain('chat.message.sender_unverified_older_format');
		expect(note.className).not.toContain('amber');
		expect(t.textContent).not.toMatch(/chat\.message\.sender_unverified(?!_older_format)/);
	});

	it('a posting-key message from a changed set: the key-change warning', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			message: msg({ text: 'hello', senderUnverified: true })
		});
		expect(t.textContent).toMatch(/chat\.message\.sender_unverified(?!_older_format)/);
		expect(t.textContent).not.toContain('older_format');
	});

	it('a proved message: no note', async () => {
		const t = await mount({ me: 'alice', peer: 'bob', message: msg({ text: 'hello' }) });
		expect(t.textContent).not.toContain('sender_unverified');
	});
});
