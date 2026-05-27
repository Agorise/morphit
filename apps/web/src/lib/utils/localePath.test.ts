import { describe, it, expect } from 'vitest';
import { localePath, fromLocalePath } from './localePath';
import { SUPPORTED_LOCALES } from '../i18n/locales';

describe('localePath', () => {
	it('prefixes a simple path', () => {
		expect(localePath('/orderbook', 'es')).toBe('/es/orderbook');
	});

	it('handles the root path', () => {
		expect(localePath('/', 'de')).toBe('/de/');
	});

	it('preserves query strings', () => {
		expect(localePath('/faq?tag=fees', 'fr')).toBe('/fr/faq?tag=fees');
	});

	it('preserves hash fragments', () => {
		expect(localePath('/faq#fees', 'fr')).toBe('/fr/faq#fees');
	});

	it('preserves query + hash together', () => {
		expect(localePath('/faq?tag=fees#a', 'it')).toBe('/it/faq?tag=fees#a');
	});

	it('is idempotent on already-prefixed paths', () => {
		expect(localePath('/es/orderbook', 'es')).toBe('/es/orderbook');
	});

	it('rewrites an existing prefix when the target locale differs', () => {
		expect(localePath('/en/orderbook', 'de')).toBe('/de/orderbook');
	});

	it('handles multi-segment Chinese locale codes', () => {
		expect(localePath('/faq', 'zh-CN')).toBe('/zh-CN/faq');
		expect(localePath('/zh-HK/faq', 'zh-CN')).toBe('/zh-CN/faq');
	});

	it('rewrites zh-HK to another locale', () => {
		expect(localePath('/zh-HK/orderbook?x=1', 'ru')).toBe('/ru/orderbook?x=1');
	});

	it('does not prefix external URLs', () => {
		expect(localePath('https://example.com/', 'es')).toBe('https://example.com/');
	});

	it('does not prefix protocol-relative URLs', () => {
		expect(localePath('//cdn.example.com/asset.js', 'es')).toBe('//cdn.example.com/asset.js');
	});

	it('passes through empty strings', () => {
		expect(localePath('', 'es')).toBe('');
	});

	it('passes through relative paths unchanged', () => {
		expect(localePath('orderbook', 'es')).toBe('orderbook');
	});

	it('handles nested routes', () => {
		expect(localePath('/my/orders', 'pl')).toBe('/pl/my/orders');
	});

	it('handles nested routes with existing prefix', () => {
		expect(localePath('/en/my/orders', 'pl')).toBe('/pl/my/orders');
	});
});

describe('fromLocalePath', () => {
	it('splits a prefixed path into lang + path', () => {
		expect(fromLocalePath('/es/orderbook')).toEqual({ lang: 'es', path: '/orderbook' });
	});

	it('handles multi-segment Chinese locale', () => {
		expect(fromLocalePath('/zh-HK/faq')).toEqual({ lang: 'zh-HK', path: '/faq' });
	});

	it('handles root prefix with trailing slash', () => {
		expect(fromLocalePath('/en/')).toEqual({ lang: 'en', path: '/' });
	});

	it('handles just the locale prefix with no path', () => {
		expect(fromLocalePath('/en')).toEqual({ lang: 'en', path: '/' });
	});

	it('returns null for unprefixed paths', () => {
		expect(fromLocalePath('/orderbook')).toBeNull();
	});

	it('returns null for non-path inputs', () => {
		expect(fromLocalePath('')).toBeNull();
		expect(fromLocalePath('https://morphit.io/es/x')).toBeNull();
	});

	it('preserves query strings in path component', () => {
		expect(fromLocalePath('/es/faq?x=1')).toEqual({ lang: 'es', path: '/faq?x=1' });
	});

	it('preserves nested path segments', () => {
		expect(fromLocalePath('/de/my/orders')).toEqual({ lang: 'de', path: '/my/orders' });
	});
});

describe('localePath + fromLocalePath round-trip', () => {
	it('round-trips for every supported locale', () => {
		for (const { code } of SUPPORTED_LOCALES) {
			const prefixed = localePath('/orderbook', code as never);
			const parsed = fromLocalePath(prefixed);
			expect(parsed).not.toBeNull();
			expect(parsed!.lang).toBe(code);
			expect(parsed!.path).toBe('/orderbook');
		}
	});
});
