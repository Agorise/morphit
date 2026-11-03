// @vitest-environment jsdom
/**
 * v1.22.0 — the REAL ChatMessage bubble for an eCash (ECX) address: an eCash
 * address is also a Bitcoin address, and an eCash payment from coins held
 * before the fork can be replayed on Bitcoin, so the card names the chain and
 * warns, every time. A Bitcoin address card does not carry that warning.
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

import { encodeAddressPayload } from '$lib/chat/payload';
import * as ts from '$lib/trades/tradeStatus';

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
const SAME = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const card = (method: 'ecx' | 'btc') =>
	msg({
		text: encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method,
			address: SAME,
			amount: '0.5',
			orderPermlink: THREAD
		})
	});

describe('the eCash address card', () => {
	it('names the chain and warns about Bitcoin wallets and replay', async () => {
		const t = await mount({ me: 'alice', peer: 'bob', orderOwner: 'bob', message: card('ecx') });
		const text = t.textContent ?? '';
		expect(text).toContain('chat.address.pill_method_ecx');
		expect(text).toContain('assets.ecx.address_share.warning');
		expect(text).toContain(SAME);
	});

	it('the same string shared as a Bitcoin address carries no eCash warning', async () => {
		const t = await mount({ me: 'alice', peer: 'bob', orderOwner: 'bob', message: card('btc') });
		const text = t.textContent ?? '';
		expect(text).toContain('chat.address.pill_method_btc');
		expect(text).not.toContain('assets.ecx.address_share.warning');
	});
});
