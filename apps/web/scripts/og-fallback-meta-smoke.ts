#!/usr/bin/env tsx
/**
 * apps/web/scripts/og-fallback-meta-smoke.ts
 *
 * v1.8.0 (t.txt) — link-preview fallback for non-prerendered / bare URLs.
 *
 * The site ships with `fallback: 'index.html'` (svelte.config.js). Any URL
 * that isn't a prerendered `/<lang>/…` route — a bare `/chat`, a dynamic
 * `/<lang>/chat/<peer>`, or a link pasted WITHOUT the locale prefix — is
 * served the SPA shell, whose `%sveltekit.head%` is empty until JS hydrates.
 * A link-preview scraper (Element/Matrix, Slack, Discord, …) never runs that
 * JS, so with no OG tags it scraped the visible <noscript> <h1> ("Morphit
 * works without JavaScript — partly.") as the title and the favicon as the
 * image — the exact ugly preview Ken reported.
 *
 * The fix is a block of STATIC default og:/twitter: tags in app.html, before
 * `%sveltekit.head%`, so every fallback URL has a correct default card.
 * Head.svelte re-emits route-specific tags below these on prerendered routes;
 * scalar OG properties are last-wins, so the route-specific values still win
 * there. This smoke pins the invariant so the fallback can't silently regress.
 *
 * Scenarios:
 *   1. app.html has a static og:title, and it is NOT the noscript heading
 *   2. app.html has og:image → the canonical PNG (absolute morphit.io URL)
 *   3. app.html declares og:image dimensions + type (large-card eligibility)
 *   4. app.html sets twitter:card = summary_large_image
 *   5. the static OG block appears BEFORE %sveltekit.head% (so route tags win)
 *   6. app.html has NO static <title> (browsers honour the FIRST <title>, so a
 *      static one would clobber every prerendered route's tab title)
 *   7. the noscript heading still exists (kept for real no-JS users) but is no
 *      longer the only title signal a scraper can find
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const APP_HTML = join(REPO, 'apps/web/src/app.html');

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}`);
		failed++;
	}
}

if (!existsSync(APP_HTML)) {
	console.error(`og-fallback-meta-smoke: app.html not found at ${APP_HTML}`);
	process.exit(1);
}
// Analyse the real markup only: strip HTML comments so the explanatory
// comment block (which necessarily mentions %sveltekit.head% and the words
// "static <title>") can't create false positives.
const html = readFileSync(APP_HTML, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');

const headIdx = html.indexOf('%sveltekit.head%');
const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/);
const ogTitleIdx = ogTitleMatch ? html.indexOf(ogTitleMatch[0]) : -1;

// 1 — og:title present and not the noscript "works without JavaScript" line.
check(
	'app.html has a static og:title that is not the noscript heading',
	!!ogTitleMatch &&
		/Morphit/.test(ogTitleMatch[1]!) &&
		!/without JavaScript/i.test(ogTitleMatch[1]!)
);

// 2 — og:image is the canonical absolute PNG.
check(
	'app.html og:image points at the absolute morphit.io/og-image.png',
	/<meta\s+property="og:image"\s+content="https:\/\/morphit\.io\/og-image\.png"/.test(html)
);

// 3 — dimensions + type so scrapers render the large card, not a thumbnail.
check(
	'app.html declares og:image width/height/type',
	/<meta\s+property="og:image:width"\s+content="1200"/.test(html) &&
		/<meta\s+property="og:image:height"\s+content="630"/.test(html) &&
		/<meta\s+property="og:image:type"\s+content="image\/png"/.test(html)
);

// 4 — twitter card is the large-image variant.
check(
	'app.html sets twitter:card = summary_large_image',
	/<meta\s+name="twitter:card"\s+content="summary_large_image"/.test(html)
);

// 5 — static OG block is BEFORE %sveltekit.head% so route-specific tags (which
//     SvelteKit injects there) win via last-wins on prerendered routes.
check(
	'static og:title appears before %sveltekit.head%',
	ogTitleIdx !== -1 && headIdx !== -1 && ogTitleIdx < headIdx
);

// 6 — NO static <title> in app.html (first-<title>-wins would clobber routes).
check('app.html has no static <title> element', !/<title[\s>]/i.test(html));

// 7 — the noscript block is still there for genuine no-JS users.
check(
	'noscript no-JS explainer is still present',
	/<noscript>/.test(html) && /without JavaScript/i.test(html)
);

if (failed === 0) {
	console.log(`\n✓ all ${passed} og-fallback-meta scenarios passed`);
} else {
	console.log(`\n✗ ${failed}/${passed + failed} og-fallback-meta scenarios failed`);
	process.exit(1);
}
