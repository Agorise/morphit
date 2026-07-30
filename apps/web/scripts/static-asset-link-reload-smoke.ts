#!/usr/bin/env tsx
/**
 * static-asset-link-reload-smoke — every same-origin <a> that points at
 * a static file (a literal href like "/morphit-mediakit.zip") MUST carry
 * `data-sveltekit-reload` (or `rel="external"`).
 *
 * Why: under adapter-static the SvelteKit client router intercepts
 * same-origin <a> clicks and tries to resolve them as app routes. A
 * file URL like `/pgp_keys.asc` has no matching route — and because the
 * top-level segment is the unmatched `[lang]` param, the router treats
 * "pgp_keys.asc" as a locale, redirects to `/<lang>/pgp_keys.asc`, and
 * renders a 404 instead of letting the browser fetch the actual file
 * from the static server. `data-sveltekit-reload` forces a real browser
 * navigation so the static asset is served directly.
 *
 * This is the beta.13 footer-link bug: the mediakit and pgp_keys.asc
 * links 404'd with a spurious `/<lang>/` prefix until the attribute was
 * added. The same latent bug existed on the security and
 * about-this-instance pages. This smoke prevents it recurring.
 *
 * Scope: literal `href="/<path>.<ext>"` anchors where <ext> is a static
 * file type the app ships (zip|asc|txt|xml|pdf|json). Off-origin links
 * (`http(s)://…`, `//…`) and `lp()`/dynamic hrefs are not in scope.
 *
 * Scenarios:
 *   1. Every in-scope static-asset anchor includes data-sveltekit-reload
 *      (or rel="external").
 *   2. Sanity meta-check: at least one in-scope anchor was found
 *      (catches a refactor that drops all of them, which would make
 *      scenario 1 vacuously pass).
 *
 * Usage:
 *   tsx apps/web/scripts/static-asset-link-reload-smoke.ts
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const WEB_SRC = join(REPO_ROOT, 'apps', 'web', 'src');

// Static file extensions that must bypass the SPA router.
const STATIC_EXT = ['zip', 'asc', 'txt', 'xml', 'pdf', 'json'];
const HREF_RE = new RegExp(`href="/[^"]+\\.(?:${STATIC_EXT.join('|')})"`);

interface ScenarioResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: ScenarioResult[] = [];

/** Recursively collect *.svelte files under a directory. */
function collectSvelte(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	for (const ent of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
			out.push(...collectSvelte(full));
		} else if (ent.name.endsWith('.svelte')) {
			out.push(full);
		}
	}
	return out;
}

/** Match each <a …> opening tag in a blob (attributes may span lines).
 *  Attribute values here never contain '>', so `[^>]*` is safe. */
function anchorTags(text: string): string[] {
	return text.match(/<a\b[^>]*>/g) ?? [];
}

function main(): void {
	const files = collectSvelte(WEB_SRC);

	let inScopeAnchors = 0;
	const violations: string[] = [];

	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		for (const tag of anchorTags(text)) {
			if (!HREF_RE.test(tag)) continue; // not a static-asset anchor
			inScopeAnchors += 1;
			const hasReload = tag.includes('data-sveltekit-reload');
			const hasExternal = /rel="[^"]*\bexternal\b[^"]*"/.test(tag);
			if (!hasReload && !hasExternal) {
				const href = tag.match(HREF_RE)?.[0] ?? '(?)';
				violations.push(`${relative(REPO_ROOT, file)} — ${href} lacks data-sveltekit-reload`);
			}
		}
	}

	results.push({
		name: 'static_asset_anchors_have_reload',
		ok: violations.length === 0,
		detail:
			violations.length === 0
				? `all ${inScopeAnchors} static-asset anchor(s) force a real navigation`
				: `${violations.length} static-asset anchor(s) missing data-sveltekit-reload:\n    - ${violations.join('\n    - ')}`
	});

	results.push({
		name: 'meta_found_static_asset_anchors',
		ok: inScopeAnchors >= 1,
		detail:
			inScopeAnchors >= 1
				? `scanned ${inScopeAnchors} static-asset anchor(s)`
				: 'no static-asset anchors found — did the footer links move?'
	});

	let pass = 0;
	let fail = 0;
	for (const r of results) {
		if (r.ok) {
			pass += 1;
			console.log(`  PASS  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		} else {
			fail += 1;
			console.error(`  FAIL  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		}
	}
	if (fail > 0) {
		console.error(`\nstatic-asset-link-reload-smoke: ${pass} pass / ${fail} fail`);
		process.exit(1);
	}
	console.log(`\n✓ all ${pass} static-asset-link-reload scenarios passed`);
}

main();
