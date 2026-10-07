// @vitest-environment jsdom
/**
 * The orderbook language filter follows only a choice the user made in
 * Settings: posting an order never pins it, and a filter an older build
 * created from a first post is dropped once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

import {
	noteUsedPostLang,
	readLastPostLang,
	readLocalPreferredLangs,
	resolveOrderbookLangFilter,
	writeLocalPreferredLangs
} from './preferredLangs';

beforeEach(() => localStorage.clear());

describe('preferred languages', () => {
	it('a first post does not seed the orderbook language filter', () => {
		noteUsedPostLang('en', readLocalPreferredLangs() ?? ['en']);
		expect(resolveOrderbookLangFilter(null)).toEqual([]);
		expect(readLastPostLang()).toBe('en');
	});
	it('a set chosen in Settings is widened by a post in another language', () => {
		writeLocalPreferredLangs(['ru', 'pl']);
		noteUsedPostLang('en', readLocalPreferredLangs() ?? ['en']);
		expect(resolveOrderbookLangFilter(null)).toEqual(['ru', 'pl', 'en']);
	});
	it('a filter written by an older build (bare array) is dropped once', () => {
		localStorage.setItem('morphit.preferredLangs.v1', JSON.stringify(['en']));
		expect(resolveOrderbookLangFilter(null)).toEqual([]);
		expect(localStorage.getItem('morphit.preferredLangs.v1')).toBeNull();
	});
});

describe('the orderbook language filter remembers the user’s own choice (review C-2)', () => {
	it('cleared on the orderbook: the next visit shows every language, older untagged orders included', async () => {
		const m = await import('./preferredLangs');
		writeLocalPreferredLangs(['es']);
		expect(resolveOrderbookLangFilter(null)).toEqual(['es']);
		m.writeOrderbookLangFilter([]);
		expect(resolveOrderbookLangFilter(null)).toEqual([]);
	});
	it('a set picked on the orderbook is kept for the next visit', async () => {
		const m = await import('./preferredLangs');
		m.writeOrderbookLangFilter(['fr', 'xx']);
		expect(resolveOrderbookLangFilter(null)).toEqual(['fr']);
	});
	it('saving preferred languages in Settings again re-seeds the filter from them', async () => {
		const m = await import('./preferredLangs');
		m.writeOrderbookLangFilter([]);
		writeLocalPreferredLangs(['de']);
		expect(resolveOrderbookLangFilter(null)).toEqual(['de']);
	});
	it('the orderbook page writes the choice when the filter changes (call site)', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const page = readFileSync(
			join(__dirname, '..', '..', 'routes', '[lang]', 'orderbook', '+page.svelte'),
			'utf8'
		);
		expect(page).toMatch(/writeOrderbookLangFilter\(langFilter\)/);
	});
});
