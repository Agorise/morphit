// @vitest-environment jsdom
/**
 * A branded instance never puts Morphit's picture on a post its users publish
 * — also when its brand cannot be read at the moment of posting (Tor/I2P
 * timeouts, a service worker offline, a brand.json from an older upgrader).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMessages, init } from 'svelte-i18n';

import en from '$lib/i18n/locales/en.json';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
const posted: { body: string; extraMetadata?: Record<string, unknown> }[] = [];
vi.mock('$blurt/ops/comment', () => ({
	broadcastComment: async (_live: unknown, p: { body: string }) => {
		posted.push(p);
		return { block_num: 1, trx_id: 'abc' };
	}
}));
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'alice' }));

import {
	publishFirstTradePost,
	publishOrderPost,
	type OrderPostContext
} from '$lib/syndication/publish';

const ORDER: Omit<OrderPostContext, 'feeMethod'> = {
	orderPermlink: 'order-abc',
	side: 'sell',
	asset: 'BTC',
	counterAsset: 'EUR',
	amountMin: 100,
	amountMax: 500,
	paymentMethodNames: ['SEPA'],
	createdAtIso: '2026-10-01T00:00:00Z',
	expiresAtIso: null
};

const MORPHIT_PICTURE =
	'https://img.blurt.blog/blurtimage/morphit/e3d56ddc849685c391dcdb03526463b8264f3e09.png';
const ONION = 'http://ws7btkyaabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnop.onion';
function brandJsonAnswer(doc: Record<string, unknown> | null) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			if (doc === null) throw new TypeError('network');
			return new Response(JSON.stringify(doc), { status: 200 });
		})
	);
}
beforeAll(async () => {
	addMessages('en', en as never);
	await init({ fallbackLocale: 'en', initialLocale: 'en' });
});
beforeEach(() => {
	posted.length = 0;
	vi.stubGlobal('location', new URL(`${ONION}/en/@alice/order-abc`));
});
// A BRANDED hidden-only instance (morphitlat), first-trade post, from an order
// page (SPA shell: index.html is never stamped; brand.ts stamps "Morphit" when
// its own brand.json read fails).
describe('branded hidden-only instance whose brand cannot be read at post time', () => {
	it('brand.json unreachable + SPA page stamped "Morphit": must not carry the Morphit picture', async () => {
		brandJsonAnswer(null);
		document.documentElement.dataset.brandName = 'Morphit';
		await publishFirstTradePost({} as never, { seller: 'bob' });
		expect(posted[0]!.body).not.toContain(MORPHIT_PICTURE);
	});
	it('brand.json answered 503 (the service worker, offline, for a ?fresh=1 read): no Morphit picture', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('Offline', { status: 503 }))
		);
		document.documentElement.dataset.brandName = 'Morphit';
		await publishFirstTradePost({} as never, { seller: 'bob' });
		expect(posted[0]!.body).not.toContain(MORPHIT_PICTURE);
	});
	it('a branded site whose brand.json has no og_image yet (written by an older upgrader): no picture, never Morphit’s', async () => {
		vi.stubGlobal('location', new URL('https://vigilante.trading/en/@alice/order-abc'));
		brandJsonAnswer({ schema: 1, name: 'Vigilante Trading', beta_badge: false });
		document.documentElement.dataset.brandName = 'Vigilante Trading';
		await publishFirstTradePost({} as never, { seller: 'bob' });
		expect(posted[0]!.body).not.toContain(MORPHIT_PICTURE);
		expect(posted[0]!.body).not.toContain('og-image.png');
	});
	it('control: an unbranded https instance keeps the Morphit picture', async () => {
		vi.stubGlobal('location', new URL('https://morphit.io/en/@alice/order-abc'));
		brandJsonAnswer({ schema: 1, name: 'Morphit', beta_badge: true });
		document.documentElement.dataset.brandName = 'Morphit';
		await publishFirstTradePost({} as never, { seller: 'bob' });
		expect(posted[0]!.body).toContain(MORPHIT_PICTURE);
	});
	it('control: brand.json readable (og_image own) → no picture at all on Tor', async () => {
		brandJsonAnswer({ schema: 1, name: 'Libertad Latina', beta_badge: false, og_image: 'own' });
		document.documentElement.dataset.brandName = 'Morphit';
		await publishFirstTradePost({} as never, { seller: 'bob' });
		expect(posted[0]!.body).not.toContain('![');
		expect(posted[0]!.extraMetadata?.image).toBeUndefined();
	});
});
