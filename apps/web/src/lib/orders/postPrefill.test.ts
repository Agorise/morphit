/**
 * The re-list hand-off, end to end: an expired order → buildRelistPrefill →
 * the JSON the order card / detail page writes to sessionStorage →
 * parsePostPrefill → the fields /post applies.
 *
 * Reported on v1.21.18: re-listing an expired BARTER order left step 3 of 4
 * ("Which cryptos will you accept?") empty. Step 3 of a barter listing binds
 * to the accepted-crypto set (`acceptedAssets`, the order's on-chain
 * `accepted_assets`), and neither the re-list writer nor the /post reader
 * carried it — the order's `pay_<crypto>` payment methods went across, but
 * a barter listing's step 3 never reads those. The post page is too large to
 * mount, so its one apply function is pinned to the reader's fields below.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OrderRecord } from '@morphit/indexer-client';

import { buildRelistPrefill } from './relist';
import { parsePostPrefill } from './postPrefill';

const mkOrder = (over: Partial<OrderRecord>): OrderRecord =>
	({
		account: 'tester3',
		permlink: 'order-abc',
		side: 'sell',
		asset: 'BTC',
		asset_network: null,
		fiat_currency: 'MXN',
		amount_min: 500,
		amount_max: null,
		price_model: { kind: 'spread', percent: 0 },
		location_region: null,
		payment_methods: [],
		accepted_assets: null,
		terms: null,
		status: 'expired',
		...over
	}) as unknown as OrderRecord;

/** What /my/orders and the order-detail page hand /post on "Re-list". */
const relistHandOff = (o: OrderRecord, locale = 'en') =>
	parsePostPrefill(JSON.stringify(buildRelistPrefill(o, locale)));

const barter = mkOrder({
	asset: 'BARTER',
	fiat_currency: 'USD',
	amount_min: 20,
	payment_methods: ['pay_btc', 'pay_xmr', 'pay_ltc'],
	accepted_assets: ['BTC', 'LTC', 'XMR'],
	specific_barter_title: 'bananas',
	terms: 'pick up at the market',
	location_region: 'Centro',
	lang: 'es'
});

describe('re-listing an expired order pre-fills /post', () => {
	it('step 3 of a barter re-list keeps every crypto the order accepted', () => {
		const p = relistHandOff(barter);
		expect(p?.asset).toBe('BARTER');
		expect(p?.acceptedAssets).toEqual(['BTC', 'LTC', 'XMR']);
	});

	it('carries every other choice of the barter order too', () => {
		expect(relistHandOff(barter)).toMatchObject({
			side: 'sell',
			fiat: 'USD',
			amountMin: '20',
			specificBarterTitle: 'bananas',
			terms: 'pick up at the market',
			region: 'Centro',
			postLang: 'es',
			expiresDays: 30
		});
	});

	it('a crypto order still carries its payment methods and accepts no cryptos', () => {
		const p = relistHandOff(
			mkOrder({ payment_methods: ['cash_in_person', 'bank_transfer'], accepted_assets: null })
		);
		expect(p?.paymentMethods).toEqual(['cash_in_person', 'bank_transfer']);
		expect(p?.acceptedAssets).toEqual([]);
	});

	it('a multi-network order lands with its network picked', () => {
		expect(relistHandOff(mkOrder({ asset: 'USDT', asset_network: 'trc20' }))?.usdtNetwork).toBe(
			'trc20'
		);
		expect(relistHandOff(mkOrder({ asset: 'USDC', asset_network: 'base' }))?.usdcNetwork).toBe(
			'base'
		);
		expect(relistHandOff(mkOrder({ asset: 'DAI', asset_network: 'arbitrum' }))?.daiNetwork).toBe(
			'arbitrum'
		);
	});

	it('an order with no language leaves the post language to its usual default', () => {
		expect(relistHandOff(mkOrder({ lang: null }))).not.toHaveProperty('postLang');
	});
});

describe('parsePostPrefill keeps only well-formed values', () => {
	it('drops unknown, goods and repeated tickers from the accepted set', () => {
		const p = parsePostPrefill(
			JSON.stringify({ acceptedAssets: ['XMR', 'NOPE', 'BARTER', 7, 'XMR', 'BTC'] })
		);
		expect(p?.acceptedAssets).toEqual(['XMR', 'BTC']);
	});

	it('ignores a non-array accepted set and an unsupported language', () => {
		const p = parsePostPrefill(JSON.stringify({ acceptedAssets: 'BTC', postLang: 'xx' }));
		expect(p).not.toHaveProperty('acceptedAssets');
		expect(p).not.toHaveProperty('postLang');
	});

	it('a network for another asset is not applied', () => {
		const p = parsePostPrefill(JSON.stringify({ asset: 'USDC', assetNetwork: 'trc20' }));
		expect(p).toEqual({ asset: 'USDC' });
	});

	it('returns null for anything that is not a JSON object', () => {
		for (const raw of ['{', 'null', '[]', '"x"', '3']) expect(parsePostPrefill(raw)).toBeNull();
	});

	it('the profile top-up prefill still reads as before', () => {
		expect(
			parsePostPrefill(
				JSON.stringify({
					side: 'buy',
					asset: 'BLURT',
					amountMin: '4',
					amountMax: '',
					topupUsdMin: 4,
					reason: 'topup'
				})
			)
		).toEqual({ side: 'buy', asset: 'BLURT', amountMin: '4', amountMax: '', topupUsdMin: 4 });
	});
});

describe('/post applies every field the reader returns', () => {
	const page = readFileSync(
		fileURLToPath(new URL('../../routes/[lang]/post/+page.svelte', import.meta.url)),
		'utf8'
	);
	const body = (() => {
		const start = page.indexOf('function applyPostPrefill(');
		expect(start).toBeGreaterThan(-1);
		return page.slice(start, page.indexOf('\n\t}\n', start));
	})();

	it('step 3 (accepted cryptos) and the post language are applied', () => {
		expect(body).toMatch(
			/if \(p\.acceptedAssets !== undefined\) acceptedAssets = p\.acceptedAssets;/
		);
		expect(body).toMatch(/if \(p\.postLang !== undefined\) postLang = p\.postLang;/);
	});

	it('every PostPrefill field has its assignment', () => {
		const src = readFileSync(fileURLToPath(new URL('./postPrefill.ts', import.meta.url)), 'utf8');
		const iface = src.slice(
			src.indexOf('export interface PostPrefill {'),
			src.indexOf('\n}\n', src.indexOf('export interface PostPrefill {'))
		);
		const fields = [...iface.matchAll(/^\t(\w+)\?:/gm)].map((m) => m[1]!);
		expect(fields.length).toBeGreaterThan(15);
		for (const f of fields) expect(body).toContain(`if (p.${f} !== undefined) `);
	});

	it('the prefill is read through parsePostPrefill and applied once', () => {
		expect(page.match(/parsePostPrefill\(raw\)/g)).toHaveLength(1);
		expect(page.match(/applyPostPrefill\(p\)/g)).toHaveLength(1);
	});
});
