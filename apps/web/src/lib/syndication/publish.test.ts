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

beforeAll(async () => {
	addMessages('en', en as never);
	await init({ fallbackLocale: 'en', initialLocale: 'en' });
});
beforeEach(() => {
	posted.length = 0;
	at('https://alice.example');
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
