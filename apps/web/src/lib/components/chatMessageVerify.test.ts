// @vitest-environment jsdom
/**
 * A payment claim shown before the trade it pays is recorded (the address
 * share lands in the store later: a slower read, a reconnect) is still
 * verified once it is. The bubble's check waited for an engaged trade and
 * never looked again (C-L3 follow-up).
 *
 * The REAL ChatMessage and trade store; only the chain read is faked.
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

beforeEach(async () => {
	(await import('$lib/trades/tradeStatus')).clearAllTradeStates();
	(await import('$lib/chat/blurtVerify'))._clearVerifyCache();
});

describe('a claim verified once its trade is recorded', () => {
	it('the address share recorded after the claim is shown: verified then', async () => {
		const ts = await import('$lib/trades/tradeStatus');
		chainTxs.set('b'.repeat(40), transferTx('bob', 'alice', '500.000 BLURT', 'mabcdefghijk'));
		const { encodeFundsSentPayload } = await import('$lib/chat/payload');
		const claim = encodeFundsSentPayload({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'blurt',
			txid: 'b'.repeat(40),
			amount: '500',
			orderPermlink: 'sell-blurt-1',
			memo: 'mabcdefghijk'
		} as never);
		const { flushSync } = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'alice',
			message: msg({ text: claim })
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(ts.getTradeState('alice', 'sell-blurt-1')).toBeNull();
		// Our address share to bob is recorded now.
		ts.recordAddressShared({
			orderOwner: 'alice',
			orderPermlink: 'sell-blurt-1',
			peer: 'bob',
			method: 'blurt',
			address: 'alice',
			expectedAmount: 500,
			expectedMemo: 'mabcdefghijk',
			direction: 'outgoing'
		});
		flushSync();
		await vi.waitFor(
			() => expect(ts.getTradeState('alice', 'sell-blurt-1')?.phase).toBe('paid_verified'),
			{ timeout: 2_000 }
		);
		expect(ts.getTradeState('alice', 'sell-blurt-1')?.amountConfirmed).toBe(true);
	});
});
