/**
 * The client refuses exactly the op text every indexer refuses (dispatcher,
 * `invalid_text`, judged after the consensus activation time), so nothing is
 * signed or paid for that the indexer then drops. Checked against the
 * indexer's own functions, not a copy of them.
 */
import { describe, expect, it } from 'vitest';
import { hasXmlNoncharacter, pgSafeDeep } from '../../../../indexer/src/db/pgText';
import { opTextRefused } from './opTextGate';
import { stripSingleLineForbidden, termsHasForbiddenChar } from '$lib/orders/termsForbiddenChars';
import { buildOrderPayload } from '$lib/orders/payload';

const STRINGS = [
	'plain',
	'café 東京 👍🏽',
	'nul\u0000x',
	'lone \uD800 high',
	'lone \uDC00 low',
	'pair 👍 ok',
	'non ￾ char',
	'non ￿ char',
	'� replacement is fine',
	'﷐ other noncharacter (indexer accepts)'
];

/** The dispatcher's verdict for a parsed payload after the activation time. */
function indexerRefuses(parsed: unknown): boolean {
	return pgSafeDeep(parsed) !== parsed || hasXmlNoncharacter(parsed);
}

describe('op text: the client refuses what every indexer refuses', () => {
	it.each(STRINGS)('value %#', (s) => {
		const payload = JSON.parse(JSON.stringify({ terms: s, list: [s] }));
		expect(opTextRefused(payload)).toBe(indexerRefuses(payload));
	});
	it.each(STRINGS)('key %#', (s) => {
		const payload = JSON.parse(JSON.stringify({ [s]: 1 }));
		expect(opTextRefused(payload)).toBe(indexerRefuses(payload));
	});
	it('the order form flags terms holding U+FFFE / U+FFFF (shown before anything is paid)', () => {
		expect(termsHasForbiddenChar('pay me ￿')).toBe(true);
		expect(termsHasForbiddenChar('pay me ￾')).toBe(true);
	});
	it('single-line fields lose U+FFFE / U+FFFF before they are sent', () => {
		expect(stripSingleLineForbidden('Zürich￿')).toBe('Zürich');
		const p = buildOrderPayload('o-1', {
			side: 'sell',
			asset: 'BTC',
			fiatCurrency: 'usd',
			amountMin: 10,
			amountMax: 100,
			priceModel: { kind: 'spread', percent: 1 },
			paymentMethods: ['cash￾'],
			locationRegion: 'Zürich￿',
			terms: '',
			expiresDays: 30
		} as never);
		expect(indexerRefuses(JSON.parse(JSON.stringify(p)))).toBe(false);
	});
});

describe('the broadcast boundary refuses such text before signing', () => {
	it('broadcastCustomJson throws invalid_text and contacts nothing', async () => {
		const { broadcastCustomJson } = await import('./sign');
		const { BroadcastError } = await import('./broadcastTransport');
		let fetched = false;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			fetched = true;
			throw new Error('network');
		}) as typeof fetch;
		try {
			const err = await broadcastCustomJson(
				{} as never,
				'morphit_profile_v1' as never,
				{ display_name: 'x', json_metadata: { short_bio: 'hi ￿' } },
				'alice'
			).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(BroadcastError);
			expect((err as { code: string }).code).toBe('invalid_text');
			expect(fetched).toBe(false);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
	it('prepareUnsignedOrderWithFee throws invalid_text before building the fee transfer', async () => {
		const { prepareUnsignedOrderWithFee } = await import('./sign');
		const err = await prepareUnsignedOrderWithFee(
			'morphit_order_v1' as never,
			{ permlink: 'o-1', terms: 'pay ￾' },
			'alice',
			[{ to: 'morphit-fees', amount: '62.500 BLURT' }],
			'morphit-fee:o-1'
		).catch((e: unknown) => e);
		expect((err as { code?: string }).code).toBe('invalid_text');
	});
});
