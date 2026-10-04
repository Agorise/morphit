/**
 * The build scan behind: a page may name the build origin only where
 * origin-slots.mjs recorded it (the only places an instance's origin is
 * written in), never anywhere else — e.g. a fixed `<meta>` in app.html.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { originLeaks } from '../../../scripts/origin-leak-scan.mjs';

const ORIGIN = 'https://morphit.io';
let dir = '';

function build(
	pages: Record<string, string>,
	slots: Record<string, Array<[number, number]>>
): string {
	dir = mkdtempSync(join(tmpdir(), 'origin-scan-'));
	for (const [rel, html] of Object.entries(pages)) writeFileSync(join(dir, rel), html);
	writeFileSync(
		join(dir, '.origin-slots.json'),
		JSON.stringify({ schema: 1, build_origin: ORIGIN, applied_origin: ORIGIN, files: slots })
	);
	return dir;
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('origin leak scan', () => {
	it('an origin inside a recorded slot is fine', () => {
		const page = `<link rel="canonical" href="${ORIGIN}/en/faq">`;
		const at = page.indexOf(ORIGIN);
		expect(
			originLeaks(build({ 'faq.html': page }, { 'faq.html': [[at, ORIGIN.length]] })).leaks
		).toEqual([]);
	});

	it('a fixed meta tag in every page and in index.html is a leak', () => {
		const head = `<meta property="og:image" content="${ORIGIN}/og-image.png" />`;
		const r = originLeaks(build({ 'index.html': head, 'faq.html': head }, {}));
		expect(r.leaks.map((l) => l.file).sort()).toEqual(['faq.html', 'index.html']);
	});

	it('http: and protocol-relative forms count; a longer host does not', () => {
		const page = `<a href="http://morphit.io/x"></a><img src="//morphit.io/a.png"><a href="https://morphit.io.evil.example/">`;
		expect(originLeaks(build({ 'a.html': page }, {})).leaks).toHaveLength(2);
	});
});
