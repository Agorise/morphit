// @vitest-environment jsdom
/**
 * v1.21.6: the Blurt posts a user publishes name the SITE they use ("I joined
 * Vigilante Trading", "Check out my offer on Vigilante Trading!"), the way
 * the app fills `{brand}` into a locale bundle when it loads.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { addMessages, init } from 'svelte-i18n';

import en from '$lib/i18n/locales/en.json';
import { applyBrandToMessages } from '$lib/brand/brandName';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
const posted: { title: string; body: string }[] = [];
vi.mock('$blurt/ops/comment', () => ({
	broadcastComment: async (_live: unknown, p: { title: string; body: string }) => {
		posted.push(p);
		return { block_num: 1, trx_id: 'abc' };
	}
}));
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'alice' }));

import { publishFirstTradePost, publishOrderPost } from './publish';

const SITE = 'Vigilante Trading';

beforeAll(async () => {
	addMessages('en', applyBrandToMessages(en, () => SITE) as never);
	await init({ fallbackLocale: 'en', initialLocale: 'en' });
	vi.stubGlobal('location', new URL('https://vigilante.example/en/post'));
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify({ schema: 1, name: SITE }), { status: 200 }))
	);
	document.documentElement.dataset.brandName = SITE;
});

describe('posts name the site the user publishes from', () => {
	it('the first-trade post', async () => {
		posted.length = 0;
		await publishFirstTradePost({} as never, { seller: 'bob' });
		expect(posted[0]!.title).toContain(`on ${SITE}`);
		expect(posted[0]!.body).toContain(`I joined ${SITE}`);
		expect(`${posted[0]!.title}\n${posted[0]!.body}`).not.toMatch(/\{brand|I joined Morphit/);
	});
	it('the order post', async () => {
		posted.length = 0;
		await publishOrderPost({} as never, {
			orderPermlink: 'order-abc',
			side: 'sell',
			asset: 'BTC',
			counterAsset: 'EUR',
			amountMin: 100,
			amountMax: 500,
			paymentMethodNames: ['SEPA'],
			createdAtIso: '2026-10-01T00:00:00Z',
			expiresAtIso: null,
			feeMethod: 'blurt'
		});
		expect(posted[0]!.body).toContain(`Check out my offer on ${SITE}!`);
		expect(posted[0]!.body).not.toMatch(/\{brand/);
	});
});
