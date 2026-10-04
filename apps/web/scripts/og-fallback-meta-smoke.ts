#!/usr/bin/env tsx
/**
 * apps/web/scripts/og-fallback-meta-smoke.ts
 *
 * Link previews, on two kinds of URL:
 *
 * FALLBACK URLS. Any URL that isn't a prerendered `/<lang>/…` route is served
 * the SPA shell (`fallback: 'index.html'`), rendered from app.html with an
 * empty `%sveltekit.head%`. A link-preview scraper never runs the JavaScript,
 * so app.html carries a static default card (og:title, og:description,
 * twitter:card …) or the scraper takes the <noscript> heading as the title.
 * What app.html must NOT carry is an absolute URL: the shell is on the on-chain
 * integrity manifest, so no instance can rewrite it, and a fixed
 * `https://morphit.io` there would name the flagship on every other instance
 * and a clearnet site on a hidden-only one.
 *
 * PRERENDERED PAGES. og:url, og:image and twitter:image come from Head.svelte,
 * built for the build origin and rewritten to each instance's own origin at
 * install/upgrade (apps/web/scripts/origin-slots.mjs). That behaviour is proven
 * by rendering Head.svelte server-side in src/lib/components/Head.ssr.test.ts,
 * which this smoke runs — and runs again against scratch copies of Head.svelte
 * with each tag removed, each of which must FAIL.
 *
 * When a build newer than app.html exists, the built shell and a prerendered
 * page are checked too.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const REPO = resolve(WEB, '..', '..');
const APP_HTML = join(WEB, 'src/app.html');
const HEAD = join(WEB, 'src/lib/components/Head.svelte');
const HEAD_TEST = 'src/lib/components/Head.ssr.test.ts';
const VITEST = join(REPO, 'node_modules/.bin/vitest');

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failed++;
	}
}

/** Absolute http(s) URLs in markup (comments excluded). */
const absoluteUrls = (html: string): string[] =>
	html.replace(/<!--[\s\S]*?-->/g, '').match(/https?:\/\/[^\s"'<>)]+/g) ?? [];

// ── app.html: the fallback card ──────────────────────────────────────────────
if (!existsSync(APP_HTML)) {
	console.error(`og-fallback-meta-smoke: app.html not found at ${APP_HTML}`);
	process.exit(1);
}
const raw = readFileSync(APP_HTML, 'utf-8');

// SvelteKit string-replaces %sveltekit.*% tokens everywhere in app.html —
// comments too — and the injected head's hydration markers would end the
// comment early, spilling its prose onto the page.
const commentBlocks = raw.match(/<!--[\s\S]*?-->/g) ?? [];
check(
	'no app.html comment embeds a %sveltekit.*% token (it would be replaced and break the comment)',
	commentBlocks.every((c) => !/%sveltekit\.[a-z]+%/.test(c))
);

const html = raw.replace(/<!--[\s\S]*?-->/g, '');
const headIdx = html.indexOf('%sveltekit.head%');
const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/);
const ogTitleIdx = ogTitleMatch ? html.indexOf(ogTitleMatch[0]) : -1;

check(
	'app.html has a static og:title that is not the noscript heading',
	!!ogTitleMatch &&
		/Morphit/.test(ogTitleMatch[1]!) &&
		!/without JavaScript/i.test(ogTitleMatch[1]!)
);
check(
	'app.html sets twitter:card = summary_large_image',
	/<meta\s+name="twitter:card"\s+content="summary_large_image"/.test(html)
);
check(
	'static og:title appears before %sveltekit.head% (route tags come after it and win)',
	ogTitleIdx !== -1 && headIdx !== -1 && ogTitleIdx < headIdx
);
check('app.html has no static <title> element', !/<title[\s>]/i.test(html));
check(
	'noscript no-JS explainer is still present',
	/<noscript>/.test(html) && /without JavaScript/i.test(html)
);
const appUrls = absoluteUrls(raw);
check(
	'app.html carries no absolute URL (no hard-coded site origin in the shell)',
	appUrls.length === 0,
	`found: ${appUrls.join(', ')}`
);
check(
	'app.html leaves og:url, og:image and twitter:image to Head.svelte',
	!/<meta\s+(?:property|name)="(?:og:url|og:image|twitter:image)"/.test(html)
);

// ── Head.svelte, rendered as prerender does ─────────────────────────────────
function runHeadTest(component?: string): { ok: boolean; out: string } {
	const r = spawnSync(VITEST, ['run', HEAD_TEST], {
		cwd: WEB,
		encoding: 'utf8',
		env: { ...process.env, ...(component ? { HEAD_COMPONENT: component } : {}) },
		timeout: 120_000
	});
	return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const real = runHeadTest();
check(
	'Head.svelte emits og:url, og:image and twitter:image from the instance origin (Head.ssr.test.ts)',
	real.ok,
	real.out
		.split('\n')
		.filter((l) => /×|→|Error/.test(l))
		.slice(0, 6)
		.join('\n      ')
);

// Self-test: the check has teeth — a Head.svelte without one of the tags fails.
const MUTANTS: ReadonlyArray<readonly [string, RegExp]> = [
	['og:url', /^\s*<meta property="og:url" content=\{canonical\} \/>\n/m],
	['og:image', /^\s*<meta property="og:image" content=\{ogImagePng\} \/>\n/m],
	['twitter:image', /^\s*<meta name="twitter:image" content=\{ogImagePng\} \/>\n/m]
];
const headSrc = readFileSync(HEAD, 'utf8');
// Inside the workspace, so the copy resolves its imports and the test's
// module mocks exactly as the real component does.
const mutDir = join(WEB, `.smoke-og-mutants-${process.pid}`);
mkdirSync(mutDir, { recursive: true });
try {
	for (const [name, line] of MUTANTS) {
		const mutated = headSrc.replace(line, '');
		if (mutated === headSrc) {
			check(`self-test: Head.svelte still has the ${name} line this smoke removes`, false);
			continue;
		}
		const file = join(mutDir, `Head-no-${name.replace(':', '-')}.svelte`);
		writeFileSync(file, mutated);
		check(`self-test: a Head.svelte without ${name} fails the check`, !runHeadTest(file).ok);
	}
} finally {
	rmSync(mutDir, { recursive: true, force: true });
}

// ── The build, when one is present and current ──────────────────────────────
const BUILD = join(WEB, 'build');
const shell = join(BUILD, 'index.html');
const page = join(BUILD, 'en/faq.html');
const slotsFile = join(BUILD, '.origin-slots.json');
if (
	existsSync(shell) &&
	existsSync(page) &&
	existsSync(slotsFile) &&
	statSync(shell).mtimeMs >= statSync(APP_HTML).mtimeMs &&
	statSync(page).mtimeMs >= statSync(HEAD).mtimeMs
) {
	const shellUrls = absoluteUrls(readFileSync(shell, 'utf8'));
	check(
		'build: the SPA shell (index.html) carries no absolute URL',
		shellUrls.length === 0,
		`found: ${shellUrls.join(', ')}`
	);
	const text = readFileSync(page, 'utf8');
	const map = JSON.parse(readFileSync(slotsFile, 'utf8')) as {
		applied_origin: string;
		files: Record<string, Array<[number, number]>>;
	};
	const recorded = new Set((map.files['en/faq.html'] ?? []).map(([at]) => at));
	for (const [attr, key] of [
		['property', 'og:url'],
		['property', 'og:image'],
		['name', 'twitter:image']
	] as const) {
		const m = new RegExp(`<meta ${attr}="${key}" content="`).exec(text);
		const at = m ? m.index + m[0].length : -1;
		check(
			`build: en/faq.html ${key} starts on a recorded origin slot (rewritten per instance)`,
			at >= 0 && recorded.has(at) && text.startsWith(map.applied_origin, at)
		);
	}
} else {
	console.log(
		'  · no current build (apps/web/build older than app.html / Head.svelte): build checks skipped'
	);
}

if (failed === 0) {
	console.log(`\n✓ all ${passed} og-fallback-meta scenarios passed`);
} else {
	console.log(`\n✗ ${failed}/${passed + failed} og-fallback-meta scenarios failed`);
	process.exit(1);
}
