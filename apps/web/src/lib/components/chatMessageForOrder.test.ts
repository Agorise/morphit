// @vitest-environment jsdom
/**
 * v1.23.2 — the address card's "For order: order-…" line. The share window
 * now writes that text as the note's default, so the card does not say it
 * twice. Review: the line is hidden only when the note IS that default (in
 * this reader's language), never because the peer's note merely mentions
 * the order — "NOT for order-…" must not hide what the payload says.
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
const ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const card = (note?: string) =>
	msg({
		text: encodeAddressPayload({
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: ADDR,
			amount: '0.5',
			orderPermlink: THREAD,
			...(note !== undefined ? { note } : {})
		})
	});
const forOrderLines = (t: HTMLElement) =>
	[...t.querySelectorAll('p')].filter(
		(p) =>
			p.querySelector('code')?.textContent === THREAD && p.textContent?.includes('pill_for_order')
	);

describe('the address card: "For order" once', () => {
	it('no note: the line is there', async () => {
		const t = await mount({ me: 'alice', peer: 'bob', orderOwner: 'bob', message: card() });
		expect(forOrderLines(t)).toHaveLength(1);
	});
	it('the default note ("For order: order-…"): said once, by the note', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: card(`chat.address.pill_for_order: ${THREAD}`)
		});
		expect(forOrderLines(t)).toHaveLength(0);
		expect(t.textContent).toContain(`chat.address.pill_for_order: ${THREAD}`);
	});
	it('a note that only mentions the order keeps the line', async () => {
		const t = await mount({
			me: 'alice',
			peer: 'bob',
			orderOwner: 'bob',
			message: card(`NOT for ${THREAD}`)
		});
		expect(forOrderLines(t)).toHaveLength(1);
	});
});
