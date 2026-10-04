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
