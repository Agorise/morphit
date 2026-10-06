/**
 * Brand files (logo, icons, manifest, /brand/brand.json) are served by the
 * service worker stale-while-revalidate: instant from cache, refreshed in the
 * background. Only a read marked `?fresh=1` (the Blurt post, right before
 * posting) asks for the network's copy first. v1.21.1 review: keying that on
 * the request's `cache` mode also caught the SPA shell's own brand.json read
 * (`cache: 'no-cache'`), which then waited on the network on every load.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND_FRESH_PARAM } from './dynamicPaths';

const sw = readFileSync(join(__dirname, '..', '..', 'service-worker.ts'), 'utf8');
const brandBlock =
	/if \(isBrandOverridablePath\(url\.pathname\)\) \{([\s\S]*?)\n\t\t\t\}\n/.exec(sw)?.[1] ?? '';

describe('service worker: brand files', () => {
	it('a fresh read is only the explicit ?fresh=1 marker, never the request cache mode', () => {
		expect(BRAND_FRESH_PARAM).toBe('fresh');
		expect(brandBlock).toMatch(/const wantsFresh = url\.searchParams\.has\(BRAND_FRESH_PARAM\)/);
		expect(brandBlock).not.toMatch(/req\.cache/);
		expect(brandBlock).toMatch(
			/if \(cached && !wantsFresh\) \{\s*event\.waitUntil\(refresh\);\s*return cached;/
		);
	});
	it('the SPA shell reads brand.json without the marker (stays instant from cache)', () => {
		const brand = readFileSync(join(__dirname, '..', 'brand', 'brand.ts'), 'utf8');
		expect(brand).toMatch(/fetchWithTimeout\(\s*BRAND_JSON_PATH,/);
		expect(brand).not.toMatch(/BRAND_FRESH_PARAM/);
	});
	it('the Blurt post reads it with the marker', () => {
		const pub = readFileSync(join(__dirname, '..', 'syndication', 'publish.ts'), 'utf8');
		expect(pub).toMatch(/`\$\{BRAND_JSON_PATH\}\?\$\{BRAND_FRESH_PARAM\}=1`/);
	});
});
