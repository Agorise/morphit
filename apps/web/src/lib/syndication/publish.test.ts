// @vitest-environment jsdom
/**
 * The public Blurt posts a user publishes from an instance link to THAT
 * instance, and the per-order post claims a verified listing fee only
 * when one was paid in BLURT with the order — the post is permanent.
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

import { publishFirstTradePost, publishOrderPost, type OrderPostContext } from './publish';

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

function at(origin: string) {
	vi.stubGlobal('location', new URL(`${origin}/en/post`));
}

/** What this instance serves at /brand/brand.json (null → unreachable). */
function brandJson(doc: Record<string, unknown> | null) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string) => {
			if (String(url) !== '/brand/brand.json?fresh=1') throw new Error(`unexpected fetch ${url}`);
			if (doc === null) throw new TypeError('network');
			return new Response(JSON.stringify(doc), { status: 200 });
		})
	);
}
const MORPHIT_PICTURE =
	'https://img.blurt.blog/blurtimage/morphit/e3d56ddc849685c391dcdb03526463b8264f3e09.png';

beforeAll(async () => {
	addMessages('en', en as never);
	await init({ fallbackLocale: 'en', initialLocale: 'en' });
});
beforeEach(() => {
	posted.length = 0;
	at('https://alice.example');
	brandJson({ schema: 1, name: 'Morphit', beta_badge: true });
	document.documentElement.dataset.brandName = 'Morphit';
});

const feeLine = () => (posted[0]?.body ?? '').split('\n').find((l) => l.includes('Listing fee'));

describe('per-order post: listing fee line', () => {
	it('says Verified for a BLURT fee paid with the order', async () => {
		await publishOrderPost({} as never, { ...ORDER, feeMethod: 'blurt' });
		expect(feeLine()).toContain('Verified');
	});
	it.each(['btc', 'xmr', 'waived_first_buy'] as const)(
		'claims no fee for %s',
		async (feeMethod) => {
			await publishOrderPost({} as never, { ...ORDER, feeMethod });
			expect(feeLine()).toBeUndefined();
			expect(posted[0]!.body).not.toContain('Verified');
		}
	);
});

describe('posts link to the instance they were made on', () => {
	it('the per-order post links and shows this instance', async () => {
		await publishOrderPost({} as never, { ...ORDER, feeMethod: 'blurt' });
		const body = posted[0]!.body;
		expect(body).toContain('https://alice.example/en/@alice/order-abc');
		expect(body).toContain('https://alice.example/og-image.png');
		expect(body).not.toContain('morphit.io');
		expect(posted[0]!.extraMetadata?.image).toEqual(['https://alice.example/og-image.png']);
	});
	it('from a hidden service: the link names it, and no image Blurt cannot load', async () => {
		const onion = 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion';
		at(onion);
		await publishOrderPost({} as never, { ...ORDER, feeMethod: 'blurt' });
		const body = posted[0]!.body;
		expect(body).toContain(`${onion}/en/@alice/order-abc`);
		expect(body).not.toMatch(/https:\/\//);
		expect(body).not.toContain('og-image');
		expect(posted[0]!.extraMetadata?.image).toBeUndefined();
	});
	it('the first-trade post links to the profile on this instance', async () => {
		await publishFirstTradePost({} as never, { seller: 'bob' });
		expect(posted[0]!.body).toContain('https://alice.example/en/@alice');
		expect(posted[0]!.body).not.toContain('morphit.io');
	});
});

// v1.21.1 — the pictures in both posts follow the instance's branding. Before,
// the first-trade post to the community always showed the Morphit picture.
describe('post pictures carry this instance’s branding', () => {
	const firstTrade = async () => {
		await publishFirstTradePost({} as never, { seller: 'bob' });
		return posted[0]!;
	};
	it('unbranded: the first-trade post shows the Morphit picture (hosted on Blurt, loads from any instance)', async () => {
		const p = await firstTrade();
		expect(p.body.startsWith(`![](${MORPHIT_PICTURE})\n\n`)).toBe(true);
		expect(p.extraMetadata?.image).toEqual([MORPHIT_PICTURE]);
	});
	it('branded (its own link-preview picture): the first-trade post shows it, never the Morphit picture', async () => {
		brandJson({ schema: 1, name: 'Vigilante Trading', beta_badge: false, og_image: 'own' });
		const p = await firstTrade();
		expect(p.body).not.toContain(MORPHIT_PICTURE);
		expect(p.body.startsWith('![](https://alice.example/og-image.png)\n\n')).toBe(true);
		expect(p.extraMetadata?.image).toEqual(['https://alice.example/og-image.png']);
		expect(p.body).toContain('https://alice.example/en/@alice');
	});
	it('branded and only on Tor/I2P: no picture (Blurt cannot load it), and not the Morphit one', async () => {
		at('http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion');
		brandJson({ schema: 1, name: 'Vigilante Trading', og_image: 'own' });
		const p = await firstTrade();
		expect(p.body).not.toContain('![');
		expect(p.body).not.toContain('img.blurt.blog');
		expect(p.extraMetadata?.image).toBeUndefined();
	});
	it('an https hidden service: no picture (Blurt cannot load it), and no wait for brand.json on the order post', async () => {
		at('https://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion');
		brandJson({ schema: 1, name: 'Vigilante Trading', og_image: 'own' });
		const p = await firstTrade();
		expect(p.extraMetadata?.image).toBeUndefined();
		expect(p.body).not.toContain('![');
		posted.length = 0;
		const f = vi.fn();
		vi.stubGlobal('fetch', f);
		await publishOrderPost({} as never, { ...ORDER, feeMethod: 'blurt' });
		expect(f).not.toHaveBeenCalled();
		expect(posted[0]!.extraMetadata?.image).toBeUndefined();
	});
	it('brand.json out of reach on a branded page: still never the Morphit picture', async () => {
		brandJson(null);
		document.documentElement.dataset.brandName = 'Vigilante Trading';
		const p = await firstTrade();
		expect(p.body).not.toContain(MORPHIT_PICTURE);
		expect(p.extraMetadata?.image).toEqual(['https://alice.example/og-image.png']);
	});
	// v1.21.1 review: the service worker can answer with an older
	// brand.json (no og_image flag) on a branded site.
	it('an older brand.json without the flag on a branded site: still never the Morphit picture', async () => {
		brandJson({ schema: 1, name: 'Morphit', beta_badge: true });
		document.documentElement.dataset.brandName = 'Vigilante Trading';
		let p = await firstTrade();
		expect(p.body).not.toContain(MORPHIT_PICTURE);
		posted.length = 0;
		document.documentElement.dataset.brandName = 'Morphit';
		brandJson({ schema: 1, name: 'Vigilante Trading', beta_badge: false });
		p = await firstTrade();
		expect(p.extraMetadata?.image).toEqual(['https://alice.example/og-image.png']);
	});
	it('branded, but its picture could not be drawn (og_image "shipped"): no picture in either post, never Morphit’s', async () => {
		brandJson({ schema: 1, name: 'Vigilante Trading', og_image: 'shipped' });
		const p = await firstTrade();
		expect(p.body).not.toContain('![');
		expect(p.extraMetadata?.image).toBeUndefined();
		posted.length = 0;
		await publishOrderPost({} as never, { ...ORDER, feeMethod: 'blurt' });
		expect(posted[0]!.body).not.toContain('og-image');
		expect(posted[0]!.extraMetadata?.image).toBeUndefined();
	});
	it('the per-order post shows this instance’s own link-preview picture', async () => {
		brandJson({ schema: 1, name: 'Vigilante Trading', og_image: 'own' });
		await publishOrderPost({} as never, { ...ORDER, feeMethod: 'blurt' });
		expect(
			posted[0]!.body.startsWith('![Vigilante Trading](https://alice.example/og-image.png)')
		).toBe(true);
		expect(posted[0]!.extraMetadata?.image).toEqual(['https://alice.example/og-image.png']);
	});
	it('every locale’s first-trade text carries no fixed picture (the code adds the right one)', async () => {
		const { readdirSync, readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const dir = join(__dirname, '..', 'i18n', 'locales');
		for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
			const body = (
				JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
					syndicate: { first_trade: { body: string } };
				}
			).syndicate.first_trade.body;
			expect(body, f).not.toMatch(/!\[/);
			expect(body, f).not.toContain('img.blurt.blog');
		}
	});
});
