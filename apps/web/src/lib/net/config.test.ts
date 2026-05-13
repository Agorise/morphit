// @vitest-environment jsdom
/**
 * Tests for resolveOrigin — the configured-origin normalizer
 * that lets the frontend default to same-origin relative paths
 * (e.g. '/relay') in the common colocated deployment, while
 * still accepting absolute URLs for split topologies.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';

import { resolveOrigin } from './config';

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Small helper: pretend the page was loaded from `origin` by
 *  stubbing `window.location.origin`. We avoid touching the
 *  real DOM beyond the minimum needed. */
function withWindowOrigin(origin: string): void {
	vi.stubGlobal('window', {
		location: { origin }
	});
}

describe('resolveOrigin', () => {
	it('returns an https:// URL unchanged', () => {
		expect(resolveOrigin('https://relay.example.com')).toBe('https://relay.example.com');
	});

	it('returns an http:// URL unchanged', () => {
		// Used for local dev against a non-HTTPS origin like
		// http://localhost:5173. Not production-safe — operators
		// get a config-validation warning elsewhere — but valid
		// shape-wise.
		expect(resolveOrigin('http://localhost:5173')).toBe('http://localhost:5173');
	});

	it('resolves a leading-slash relative path against window.location.origin', () => {
		withWindowOrigin('https://morphit.example.com');
		expect(resolveOrigin('/relay')).toBe('https://morphit.example.com/relay');
	});

	it('resolves a nested relative path against window.location.origin', () => {
		withWindowOrigin('https://morphit.example.com');
		expect(resolveOrigin('/api/indexer')).toBe('https://morphit.example.com/api/indexer');
	});

	it('defensively prepends a leading slash if one was omitted', () => {
		// Operators following our guidance always start with '/',
		// but if someone forgets we produce a sensible result
		// instead of 'https://morphit.example.comrelay'.
		withWindowOrigin('https://morphit.example.com');
		expect(resolveOrigin('relay')).toBe('https://morphit.example.com/relay');
	});

	it('respects window.location.origin (scheme + host + port)', () => {
		withWindowOrigin('https://morphit.example.com:8443');
		expect(resolveOrigin('/relay')).toBe('https://morphit.example.com:8443/relay');
	});

	it('throws a clear error when window is undefined and the input is relative', () => {
		// Simulate SSR / prerender. window doesn't exist.
		// Calling resolveOrigin at module-load time would hit this.
		vi.stubGlobal('window', undefined);
		expect(() => resolveOrigin('/relay')).toThrow(/called without window/i);
	});

	it('returns an absolute URL unchanged even when window is undefined', () => {
		// Consumers that pre-resolve an absolute override should
		// work even under prerender. Only the relative-path case
		// needs a browser.
		vi.stubGlobal('window', undefined);
		expect(resolveOrigin('https://relay.example.com')).toBe('https://relay.example.com');
	});

	it('is case-insensitive for the scheme detection', () => {
		expect(resolveOrigin('HTTPS://Relay.Example.com')).toBe('HTTPS://Relay.Example.com');
	});
});
