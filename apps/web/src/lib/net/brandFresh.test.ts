/**
 * Brand files (logo, icons, manifest, /brand/brand.json, /brand/theme.css) are
 * served by the service worker network-first (v1.21.8; see brandResponse.test.ts
 * for its behaviour). A read marked `?fresh=1` (the Blurt post, right before
 * posting) never gets the stored copy. v1.21.1 review: keying that on the
 * request's `cache` mode also caught the SPA shell's own brand.json read
 * (`cache: 'no-cache'`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND_FRESH_PARAM } from './dynamicPaths';

const sw = readFileSync(join(__dirname, '..', '..', 'service-worker.ts'), 'utf8');
const brandBlock =
	/if \(isBrandOverridablePath\(url\.pathname\)\) \{([\s\S]*?)\n\t\t\t\}\n/.exec(sw)?.[1] ?? '';

describe('service worker: brand files', () => {
	it('the worker answers every brand file with answerBrandRequest (its behaviour: serviceWorkerBrand.test.ts)', () => {
		expect(BRAND_FRESH_PARAM).toBe('fresh');
		expect(brandBlock).toMatch(/return answerBrandRequest\(req,/);
		expect(brandBlock).not.toMatch(/req\.cache/);
	});
	it('the SPA shell reads brand.json without the marker', () => {
		const brand = readFileSync(join(__dirname, '..', 'brand', 'brand.ts'), 'utf8');
		expect(brand).toMatch(/fetchWithTimeout\(\s*BRAND_JSON_PATH,/);
		expect(brand).not.toMatch(/BRAND_FRESH_PARAM/);
	});
	it('the Blurt post reads it with the marker', () => {
		const pub = readFileSync(join(__dirname, '..', 'syndication', 'publish.ts'), 'utf8');
		expect(pub).toMatch(/`\$\{BRAND_JSON_PATH\}\?\$\{BRAND_FRESH_PARAM\}=1`/);
	});
});
