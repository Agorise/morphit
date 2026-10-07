/**
 * The service worker's choice for a brand file: a `?fresh=1` read (the Blurt
 * post) never gets the stored copy, which may predate the site's branding.
 * Behaviour of the function the worker calls, plus that it calls it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseBrandResponse } from './dynamicPaths';

const ok = { ok: true, tag: 'network' };
const bad = { ok: false, tag: 'network-404' };
const cached = { ok: true, tag: 'cache' };

describe('service worker: which brand.json answer', () => {
	it('network first when it answers', () => {
		expect(chooseBrandResponse(ok, cached, true)).toBe(ok);
		expect(chooseBrandResponse(ok, cached, false)).toBe(ok);
	});
	it('a ?fresh=1 read with the network down: offline, never the stored copy', () => {
		expect(chooseBrandResponse(null, cached, true)).toBe('offline');
		expect(chooseBrandResponse(bad, cached, true)).toBe(bad);
	});
	it('an ordinary read with the network down: the stored copy', () => {
		expect(chooseBrandResponse(null, cached, false)).toBe(cached);
	});
	it('the worker decides with this function', () => {
		const sw = readFileSync(join(__dirname, '..', '..', 'service-worker.ts'), 'utf8');
		expect(sw).toMatch(/chooseBrandResponse\(fresh, cached, wantsFresh\)/);
	});
});
