/**
 * v1.21.5 — copy names the coins THIS instance accepts (coinTokens.ts).
 */
import { describe, expect, it } from 'vitest';
import {
	acceptedCoinTickers,
	applyCoinTokens,
	applyCoinTokensToMessages,
	hasCoinToken
} from './coinTokens';

describe('coin tokens', () => {
	it('lists every tradable coin (not barter) when nothing is switched off', () => {
		const all = acceptedCoinTickers([]);
		expect(all).toContain('BTC');
		expect(all).toContain('XMR');
		expect(all).not.toContain('BARTER');
		expect(all.length).toBe(16);
	});

	it('drops the coins the operator switched off, in any case', () => {
		const got = acceptedCoinTickers(['usdt', 'USDC', 'Dai']);
		expect(got).not.toContain('USDT');
		expect(got).not.toContain('USDC');
		expect(got).not.toContain('DAI');
		expect(got.length).toBe(13);
	});

	it('fills lists with the language’s own words, and counts as a numeral', () => {
		const off = [
			'USDT',
			'USDC',
			'DAI',
			'BCH',
			'LTC',
			'DASH',
			'DOGE',
			'ZEC',
			'ARRR',
			'DCR',
			'SOL',
			'ETH',
			'XRP'
		];
		expect(applyCoinTokens('({coins})', 'en', off)).toBe('(XMR, BTC, and BLURT)');
		expect(applyCoinTokens('{coins|or}', 'en', off)).toBe('XMR, BTC, or BLURT');
		expect(applyCoinTokens('{coins|list}', 'en', off)).toBe('XMR, BTC, BLURT');
		expect(applyCoinTokens('{coins:-blurt}', 'en', off)).toBe('XMR and BTC');
		expect(applyCoinTokens('{coins:btc,zec|or}', 'en', off)).toBe('BTC');
		expect(applyCoinTokens('one of {coin_count}', 'en', off)).toBe('one of 3');
		expect(applyCoinTokens('{coin_count}', 'fa', off)).toBe('۳');
		expect(applyCoinTokens('{coins|list}', 'zh-CN', off)).toBe('XMR、BTC、BLURT');
		expect(applyCoinTokens('{coins|list}', 'fa', off)).toBe('XMR، BTC، BLURT');
	});

	it('leaves a string without a token untouched, and walks nested bundles', () => {
		const s = 'Pay in {brand} — no coins here.';
		expect(applyCoinTokens(s, 'en', [])).toBe(s);
		const dict = { a: { b: 'x {coin_count}', c: 'plain' }, d: 'plain' };
		const out = applyCoinTokensToMessages(dict, 'en', []);
		expect(out.a.b).toBe('x 16');
		expect(out.d).toBe('plain');
		expect(applyCoinTokensToMessages({ d: 'plain' }, 'en', [])).toEqual({ d: 'plain' });
		expect(hasCoinToken('{coins:-blurt|or}')).toBe(true);
		expect(hasCoinToken('{brand}')).toBe(false);
	});
});
