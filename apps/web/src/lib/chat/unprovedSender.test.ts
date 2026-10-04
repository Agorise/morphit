// @vitest-environment jsdom
/**
 * A chat message whose sender is not proved (a v1 envelope, a key not yet
 * accepted, a replaced key) — which anyone holding only public chat keys can
 * write, e.g. the operator's indexer — never offers Pay now / Mark sent and
 * never moves a trade; a later authenticated payment corrects a state such a
 * claim (or a failed check) left. With no amount asked, a payment found on
 * chain is "received", not "verified".
 *
 * The REAL ChatMessage mounted in the browser runtime, the real trade store;
 * only the chain read (the operator's relay) is faked. From the verifier's
 * VT1 harness.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable, get } from 'svelte/store';

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
	_: readable((k: string, o?: { values?: Record<string, unknown> }) =>
		o?.values ? `${k} ${JSON.stringify(o.values)}` : k
	),
	locale: readable('en'),
	date: readable(() => ''),
	time: readable(() => ''),
	number: readable((n: number) => String(n))
}));
// The chain read for payment verification goes through the operator's relay.
const chainTxs = new Map<string, unknown>();
vi.mock('$net/chainRelay', () => ({
	ChainRelayError: class extends Error {},
	chainRelay: async (method: string, params: unknown[]) =>
		method === 'get_transaction' ? (chainTxs.get(params[0] as string) ?? null) : null
}));

afterEach(() => {
	document.body.innerHTML = '';
});

const transferTx = (from: string, to: string, amount: string, memo: string) => ({
	operations: [['transfer', { from, to, amount, memo }]],
	block_num: 1,
	transaction_id: 'x'
});

async function mount(props: Record<string, unknown>) {
	const { mount: m, flushSync } = await import('svelte');
	const { default: ChatMessage } = await import('$components/ChatMessage.svelte');
	const target = document.createElement('ul');
	document.body.append(target);
	m(ChatMessage, { target, props: props as never });
	flushSync();
	return { target, flushSync };
}
const msg = (over: Record<string, unknown>) => ({
	id: 1,
	clientTag: null,
	sender: 'bob',
	state: 'confirmed',
	createdAt: new Date('2026-10-02T12:00:00Z'),
	orderPermlink: 'sell-blurt-1',
	trxId: null,
	error: null,
	decryptFailed: false,
	localSeq: 1,
	...over
});

describe('unproved senders cannot pay, verify or badge', () => {
	it('an unproved address payload "from the seller" gets no Pay now button', async () => {
		const { encodeAddressPayload } = await import('$lib/chat/payload');
		const text = encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'blurt',
			address: 'attacker',
			amount: '500',
			orderPermlink: 'sell-blurt-1',
			memo: 'mabcdefghijk'
		} as never);
		const paid: unknown[] = [];
		const { target } = await mount({
			me: 'alice',
			peer: 'bob',
			message: msg({ text, senderUnverified: true }),
			onPayNow: (a: unknown) => paid.push(a)
		});
		const btn = [...target.querySelectorAll('button')].find((x) =>
			x.textContent?.includes('chat.address.pay_now')
		);
		btn?.click();
		expect(btn).toBeUndefined();
		expect(paid).toEqual([]);
		expect(target.textContent).toContain('chat.message.sender_unverified');
	});

	it('an unproved funds-sent claim drives nothing; the genuine payment is then verified', async () => {
		const ts = await import('$lib/trades/tradeStatus');
		// Seller alice asked bob for 500 BLURT with memo M.
		ts.recordAddressShared({
			orderPermlink: 'sell-blurt-1',
			peer: 'bob',
			method: 'blurt',
			address: 'alice',
			expectedAmount: 500,
			expectedMemo: 'mabcdefghijk',
			direction: 'outgoing'
		});
		chainTxs.set('a'.repeat(40), transferTx('bob', 'alice', '1.000 BLURT', 'mabcdefghijk')); // an older real 1 BLURT transfer
		chainTxs.set('b'.repeat(40), transferTx('bob', 'alice', '500.000 BLURT', 'mabcdefghijk')); // bob's real payment
		const { encodeFundsSentPayload } = await import('$lib/chat/payload');
		const forged = encodeFundsSentPayload({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'blurt',
			txid: 'a'.repeat(40),
			amount: '500',
			orderPermlink: 'sell-blurt-1',
			memo: 'mabcdefghijk'
		} as never);
		await mount({
			me: 'alice',
			peer: 'bob',
			message: msg({ text: forged, senderUnverified: true })
		});
		// Give the unproved claim every chance to move the trade.
		await vi
			.waitFor(
				() => expect(get(ts.tradeStates).get('sell-blurt-1')?.phase).not.toBe('address_shared'),
				{ timeout: 300 }
			)
			.catch(() => undefined);
		expect(get(ts.tradeStates).get('sell-blurt-1')?.phase).toBe('address_shared');
		const genuine = encodeFundsSentPayload({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'blurt',
			txid: 'b'.repeat(40),
			amount: '500',
			orderPermlink: 'sell-blurt-1',
			memo: 'mabcdefghijk'
		} as never);
		await mount({ me: 'alice', peer: 'bob', message: msg({ id: 2, localSeq: 2, text: genuine }) });
		await vi
			.waitFor(() => expect(get(ts.tradeStates).get('sell-blurt-1')?.phase).toBe('paid_verified'))
			.catch(() => undefined);
		expect(get(ts.tradeStates).get('sell-blurt-1')?.phase).toBe('paid_verified');
	});

	it('no amount asked: a payment found on chain shows as received, not "Verified"', async () => {
		const ts = await import('$lib/trades/tradeStatus');
		ts.recordAddressShared({
			orderPermlink: 'sell-blurt-2',
			peer: 'bob',
			method: 'blurt',
			address: 'alice',
			expectedMemo: 'mzyxwvutsrqp',
			direction: 'outgoing'
		});
		chainTxs.set('c'.repeat(40), transferTx('bob', 'alice', '1.000 BLURT', 'mzyxwvutsrqp'));
		const { encodeFundsSentPayload } = await import('$lib/chat/payload');
		const claim = encodeFundsSentPayload({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'blurt',
			txid: 'c'.repeat(40),
			amount: '1',
			orderPermlink: 'sell-blurt-2',
			memo: 'mzyxwvutsrqp'
		} as never);
		const { target, flushSync } = await mount({
			me: 'alice',
			peer: 'bob',
			message: msg({ id: 3, localSeq: 3, text: claim, orderPermlink: 'sell-blurt-2' })
		});
		await vi
			.waitFor(() => expect(get(ts.tradeStates).get('sell-blurt-2')?.phase).toBe('paid_verified'))
			.catch(() => undefined);
		flushSync();
		const st = get(ts.tradeStates).get('sell-blurt-2');
		expect(st?.phase).toBe('paid_verified');
		expect(st?.amountConfirmed).toBe(false);
		expect(target.textContent?.includes('chat.funds_sent.verify_verified')).toBe(false);
		expect(target.textContent).toContain('chat.funds_sent.verify_received_unasked');
	});
});
