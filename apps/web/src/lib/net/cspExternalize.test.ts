/**
 * The build leaves no inline executable script in any page, so the site's
 * CSP can be `script-src 'self' 'wasm-unsafe-eval'` (no 'unsafe-inline').
 * Runs the real build step on a real SvelteKit page shape.
 */
import { describe, expect, it } from 'vitest';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	readdirSync
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	externalizeInlineScripts,
	inlineScriptProblems,
	BOOT_DIR
} from '../../../scripts/csp-externalize-scripts.mjs';

const BOOT = `
				{
					__sveltekit_x1 = { base: "" };
					const element = document.currentScript.parentElement;
					Promise.all([import("/_app/immutable/entry/start.A.js"), import("/_app/immutable/entry/app.B.js")])
						.then(([kit, app]) => { kit.start(app, element, { node_ids: [0, 2], data: [null, null], form: null, error: null }); });
				}
			`;
const PAGE = (boot: string) => `<!doctype html><html lang="en"><head>
<script src="/lang-hint.js"></script>
<script type="application/ld+json">{"@type":"Organization","name":"Morphit"}</script>
</head><body><div id="svelte"><main>hi</main>
			<script>${boot}</script>
		</div></body></html>`;

function site(pages: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'csp-ext-'));
	for (const [rel, html] of Object.entries(pages)) {
		const f = join(dir, rel);
		mkdirSync(join(f, '..'), { recursive: true });
		writeFileSync(f, html);
		writeFileSync(`${f}.gz`, gzipSync(html));
	}
	return dir;
}

describe('csp-externalize-scripts', () => {
	it('moves the inline bootstrap into a content-addressed file and leaves nothing inline', () => {
		const dir = site({ 'en.html': PAGE(BOOT), 'fr/faq.html': PAGE(BOOT) });
		expect(inlineScriptProblems(readFileSync(join(dir, 'en.html'), 'utf8')).length).toBe(1);
		const r = externalizeInlineScripts(dir, () => undefined);
		expect(r).toEqual({ pages: 2, files: 1 });
		const html = readFileSync(join(dir, 'en.html'), 'utf8');
		expect(inlineScriptProblems(html)).toEqual([]);
		const src = /<script src="\/(_app\/immutable\/boot\/[0-9a-f]{20}\.js)"><\/script>/.exec(
			html
		)![1]!;
		expect(readFileSync(join(dir, src), 'utf8')).toBe(BOOT);
		// the JSON-LD data block is not a script to the browser: it stays
		expect(html).toContain('application/ld+json');
		// precompressed siblings follow the page, and the new file gets its own
		expect(gunzipSync(readFileSync(join(dir, 'en.html.gz'))).toString()).toBe(html);
		expect(existsSync(join(dir, `${src}.br`))).toBe(true);
	});

	it('is idempotent on an already-processed build', () => {
		const dir = site({ 'en.html': PAGE(BOOT) });
		externalizeInlineScripts(dir, () => undefined);
		const before = readFileSync(join(dir, 'en.html'), 'utf8');
		expect(externalizeInlineScripts(dir, () => undefined).pages).toBe(0);
		expect(readFileSync(join(dir, 'en.html'), 'utf8')).toBe(before);
		expect(readdirSync(join(dir, BOOT_DIR)).filter((f) => f.endsWith('.js')).length).toBe(1);
	});

	it('fails the build on an inline event handler it cannot move', () => {
		const dir = site({ 'en.html': PAGE(BOOT).replace('<main>', '<main onclick="x()">') });
		expect(() => externalizeInlineScripts(dir, () => undefined)).toThrow(/event-handler/);
	});
});
