// @vitest-environment jsdom
/**
 * v1.24.0 — the REAL ChatMessage bubble for a Hive, Steem or BitShares
 * address: the address is an account name, which can exist on several of
 * these chains (and on Blurt), and an exchange's deposit account needs the
 * exchange's own memo where the trade's memo goes. So the card names the coin
 * and asks for the receiver's own account, every time. A BLURT account card carries no such
 * warning (BLURT payments carry their memo and are checked on chain).
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
		o?.values ? `${k}|${JSON.stringify(o.values)}` : k
	),
	locale: readable('en'),
	date: readable(() => ''),
	time: readable(() => ''),
	number: readable((n: number) => String(n))
}));
vi.mock('$net/chainRelay', () => ({
	ChainRelayError: class extends Error {},
	chainRelay: async () => null
}));

import { encodeAddressPayload } from '$lib/chat/payload';
import * as ts from '$lib/trades/tradeStatus';

const THREAD = 'bob-sells-hive';

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
	createdAt: new Date('2026-11-09T12:00:00Z'),
	orderPermlink: THREAD,
	trxId: null,
	error: null,
	decryptFailed: false,
	localSeq: 7,
	...over
});
const NAME = 'bobtrader';
const card = (method: 'hive' | 'steem' | 'bts' | 'blurt') =>
	msg({
		text: encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method,
			address: NAME,
			amount: '12.5',
			orderPermlink: THREAD
		})
	});

describe('the Hive, Steem and BitShares address card', () => {
	for (const coin of ['hive', 'steem', 'bts'] as const) {
		it(`${coin}: names the coin and asks for the receiver's own account`, async () => {
			const t = await mount({ me: 'alice', peer: 'bob', orderOwner: 'bob', message: card(coin) });
			const text = t.textContent ?? '';
			expect(text).toContain(`chat.address.pill_method_${coin}`);
			expect(text).toContain(
				`chat.address.account_coin_warning|${JSON.stringify({ coin: coin.toUpperCase() })}`
			);
			expect(text).toContain(NAME);
		});
	}

	it('the same name shared as a BLURT account carries no such warning', async () => {
		const t = await mount({ me: 'alice', peer: 'bob', orderOwner: 'bob', message: card('blurt') });
		const text = t.textContent ?? '';
		expect(text).toContain('chat.address.pill_method_blurt');
		expect(text).not.toContain('chat.address.account_coin_warning');
	});
});
