#!/usr/bin/env node
/**
 * theme-pixel-check — screenshot a built frontend (apps/web/build) in headless
 * Chromium and, optionally, pixel-diff it against another build's screenshots.
 *
 * Used to PROVE that the per-instance colour theme (docs/BRANDING.md, "Colours")
 * leaves an unthemed instance pixel-identical to the previous release, and to
 * preview a theme. Too heavy for the smoke battery (it needs Chromium); the
 * battery runs theme-default-css-smoke instead, which compares the compiled CSS
 * custom-property values with the frozen pre-theme literals.
 *
 * HOW TO RUN the "unthemed = pixel-identical" proof (any Linux box with Node):
 *   1. Tools, outside the repo:  mkdir /tmp/pw && cd /tmp/pw &&
 *        npm i playwright-core pngjs pixelmatch@5 && npx playwright-core install chromium
 *   2. Build the OLD tree and the NEW tree (cd apps/web && npm run build in each).
 *   3. export MORPHIT_PW_MODULES=/tmp/pw/node_modules
 *      node apps/web/scripts/theme-pixel-check.mjs shoot <old>/apps/web/build /tmp/px-old
 *      node apps/web/scripts/theme-pixel-check.mjs shoot <new>/apps/web/build /tmp/px-new
 *      (same --port both times: the about-this-instance page prints the host)
 *   4. node apps/web/scripts/theme-pixel-check.mjs diff /tmp/px-old /tmp/px-new --out /tmp/px-diff
 *        → exit 0 = every pixel equal
 *      node apps/web/scripts/theme-pixel-check.mjs css-diff <old>/apps/web/build <new>/apps/web/build
 *        → every compiled CSS rule paints the same values
 *   A themed preview: copy a build, run `morphit-ops branding apply --theme …` on it
 *   (or applyBranding() from apps/ops-cli/src/lib/branding.ts), then `shoot` it.
 *
 * Usage:
 *
 *   node theme-pixel-check.mjs shoot <buildDir> <outDir> [--port 4173] [--only a,b]
 *   node theme-pixel-check.mjs diff  <dirA> <dirB> [--out <diffDir>]
 *   node theme-pixel-check.mjs css-diff <buildDirA> <buildDirB>   (needs postcss)
 *
 * `shoot` serves <buildDir> the way the production nginx does (exact file,
 * then <path>.html, then the SPA fallback index.html), blocks every
 * non-localhost request and the service worker, freezes Date, asks for reduced
 * motion (the app then stops every animation), and writes one full-page PNG per
 * scene. `diff` compares same-named PNGs and exits 1 on any differing pixel.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const baseRequire = createRequire(import.meta.url);
/** Resolve a module from here, then from MORPHIT_PW_MODULES (a node_modules
 *  folder OUTSIDE the repo holding the screenshot tools), with a clear message. */
function require(name) {
	const tries = [];
	if (process.env.MORPHIT_PW_MODULES) {
		tries.push(() => createRequire(join(process.env.MORPHIT_PW_MODULES, 'x.js'))(name));
	}
	tries.push(() => baseRequire(name));
	for (const t of tries) {
		try {
			return t();
		} catch {
			/* next */
		}
	}
	console.error(
		`theme-pixel-check: cannot load "${name}". Install the tools OUTSIDE the repo (they are not\n` +
			'Morphit dependencies): mkdir /tmp/pw && cd /tmp/pw && npm i playwright-core pngjs pixelmatch@5\n' +
			'&& npx playwright-core install chromium — then run with MORPHIT_PW_MODULES=/tmp/pw/node_modules'
	);
	process.exit(2);
}

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.webmanifest': 'application/manifest+json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain',
	'.xml': 'application/xml',
	'.wasm': 'application/wasm',
	'.ico': 'image/x-icon'
};

/** A scene: path, and an optional action run before the screenshot. */
const SCENES = [
	{ name: 'root', path: '/' },
	{ name: 'home', path: '/en/' },
	{
		name: 'home-card-hover',
		path: '/en/',
		// The 7 priority cards with card #2 hovered (border + CTA colour).
		async act(page) {
			const section = page.locator('.priorities-section').first();
			await section.scrollIntoViewIfNeeded();
			await page.locator('.priorities-card').nth(1).hover();
		},
		clip: '.priorities-section'
	},
	{
		// No JavaScript (Tor Browser "Safest"): the prerendered page alone.
		name: 'home-nojs',
		path: '/en/',
		noJs: true,
		viewportOnly: true
	},
	{
		name: 'home-button-focus',
		path: '/en/',
		// Keyboard focus (Tab) so :focus-visible — the focus ring — shows.
		async act(page) {
			for (let i = 0; i < 40; i++) {
				await page.keyboard.press('Tab');
				const hit = await page.evaluate(
					() => document.activeElement?.matches('a.btn-primary') ?? false
				);
				if (hit) break;
			}
		},
		viewportOnly: true
	},
	{ name: 'orderbook', path: '/en/orderbook' },
	{ name: 'faq', path: '/en/faq' },
	{ name: 'post', path: '/en/post' },
	{ name: 'login', path: '/en/login' },
	{ name: 'chat', path: '/en/chat' },
	{ name: 'chat-thread-spa', path: '/en/chat/alice' },
	{ name: 'explorer', path: '/en/explorer' },
	{ name: 'onboarding', path: '/en/onboarding' },
	{ name: 'fa-home', path: '/fa/' },
	{ name: 'download', path: '/en/download' },
	{ name: 'security', path: '/en/security' },
	{ name: 'instances', path: '/en/instances' },
	{ name: 'stats', path: '/en/stats' },
	{ name: 'run-a-node', path: '/en/run-a-node' },
	{ name: 'glossary', path: '/en/glossary' },
	{ name: 'about-this-instance', path: '/en/about-this-instance' },
	{ name: 'explorer-tx-spa', path: '/en/explorer/tx/0123456789abcdef0123456789abcdef01234567' }
];

function arg(name, def) {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : def;
}

function serve(root, port) {
	const server = createServer((req, res) => {
		const url = new URL(req.url, 'http://x');
		let p = decodeURIComponent(url.pathname);
		const tries = [
			p,
			`${p}.html`,
			p.endsWith('/') ? `${p.slice(0, -1)}.html` : null,
			`${p}/index.html`
		];
		let file = null;
		for (const t of tries) {
			if (!t) continue;
			const abs = join(root, t);
			if (!abs.startsWith(root)) continue;
			if (existsSync(abs) && statSync(abs).isFile()) {
				file = abs;
				break;
			}
		}
		// Indexer / relay API: fail fast and deterministically.
		if (!file && /^\/(v1|api|relay|rss|indexer)\b/.test(p)) {
			res.writeHead(404, { 'content-type': 'application/json' });
			res.end('{}');
			return;
		}
		if (!file) file = join(root, 'index.html');
		res.writeHead(200, {
			'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
			'cache-control': 'no-store'
		});
		res.end(readFileSync(file));
	});
	return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

async function shoot(buildDir, outDir, port, only) {
	const { chromium } = require('playwright-core');
	const root = resolve(buildDir);
	mkdirSync(outDir, { recursive: true });
	const server = await serve(root, port);
	const browser = await chromium.launch();
	const scenes = only ? SCENES.filter((s) => only.includes(s.name)) : SCENES;
	try {
		for (const s of scenes) {
			const ctx = await browser.newContext({
				viewport: { width: 1280, height: 900 },
				deviceScaleFactor: 1,
				reducedMotion: 'reduce',
				serviceWorkers: 'block',
				colorScheme: 'dark',
				locale: 'en-US',
				timezoneId: 'UTC',
				javaScriptEnabled: !s.noJs
			});
			await ctx.route(/.*/, (route) => {
				const u = new URL(route.request().url());
				if (u.hostname === '127.0.0.1' && u.port === String(port)) return route.continue();
				return route.abort();
			});
			const page = await ctx.newPage();
			if (!s.noJs) await page.clock.setFixedTime(new Date('2026-09-01T12:00:00Z'));
			await page.goto(`http://127.0.0.1:${port}${s.path}`, { waitUntil: 'networkidle' });
			if (!s.noJs) await page.evaluate(() => document.fonts.ready);
			else await page.waitForTimeout(800);
			// Below-the-fold sections lazy-load on scroll: bring them all in, then
			// return to the top, so every run captures the same page.
			for (let y = 0; y < (s.noJs ? 0 : 4); y++) {
				await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
				await page.waitForTimeout(400);
			}
			await page.waitForLoadState('networkidle');
			if (!s.noJs) {
				await page.evaluate(() => window.scrollTo(0, 0));
				await page.waitForTimeout(1200);
			}
			if (s.act) {
				await s.act(page);
				await page.waitForTimeout(400);
			}
			const file = join(outDir, `${s.name}.png`);
			if (s.clip) {
				const box = await page.locator(s.clip).first().boundingBox();
				await page.screenshot({ path: file, clip: box, animations: 'disabled' });
			} else {
				await page.screenshot({
					path: file,
					fullPage: !s.viewportOnly,
					animations: 'disabled',
					caret: 'hide'
				});
			}
			console.log(`  shot ${s.name} (${s.path})`);
			await ctx.close();
		}
	} finally {
		await browser.close();
		server.close();
	}
}

function diff(a, b, out) {
	const { PNG } = require('pngjs');
	const pm = require('pixelmatch');
	const pixelmatch = typeof pm === 'function' ? pm : pm.default;
	let bad = 0;
	const names = readdirSync(a)
		.filter((n) => n.endsWith('.png'))
		.sort();
	if (out) mkdirSync(out, { recursive: true });
	for (const n of names) {
		if (!existsSync(join(b, n))) {
			console.log(`  ✗ ${n}: missing in ${b}`);
			bad++;
			continue;
		}
		const A = PNG.sync.read(readFileSync(join(a, n)));
		const B = PNG.sync.read(readFileSync(join(b, n)));
		if (A.width !== B.width || A.height !== B.height) {
			console.log(`  ✗ ${n}: size ${A.width}x${A.height} vs ${B.width}x${B.height}`);
			bad++;
			continue;
		}
		const D = new PNG({ width: A.width, height: A.height });
		const n0 = pixelmatch(A.data, B.data, D.data, A.width, A.height, { threshold: 0 });
		if (n0 === 0) console.log(`  ✓ ${n}: 0 differing pixels (${A.width}x${A.height})`);
		else {
			console.log(`  ✗ ${n}: ${n0} differing pixels`);
			if (out) writeFileSync(join(out, n), PNG.sync.write(D));
			bad++;
		}
	}
	console.log(
		bad === 0
			? `✓ all ${names.length} screenshots pixel-identical`
			: `✗ ${bad} of ${names.length} differ`
	);
	return bad === 0 ? 0 : 1;
}

let postcss;
function cssFiles(build) {
	const dir = join(build, '_app', 'immutable', 'assets');
	return readdirSync(dir)
		.filter((f) => f.endsWith('.css'))
		.map((f) => readFileSync(join(dir, f), 'utf8'));
}

function rootVars(css) {
	const vars = {};
	postcss.parse(css).walkRules((r) => {
		if (r.selector !== ':root') return;
		r.walkDecls((d) => {
			if (d.prop.startsWith('--')) vars[d.prop] = d.value.trim();
		});
	});
	return vars;
}

// var(--x) / var(--x, fallback) → the :root value (or the fallback when --x is
// defined nowhere, which is what the browser does). Tailwind's --tw-* plumbing
// is left alone (identical on both sides).
function subst(value, vars, depth = 0) {
	if (depth > 10) return value;
	let changed = false;
	const out = value.replace(
		/var\((--[a-z0-9-]+)(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/gi,
		(m, name, fb) => {
			if (
				name.startsWith('--tw-') ||
				name.startsWith('--carousel-') ||
				name === '--morphit-wordmark' ||
				name === '--card-watermark'
			)
				return m;
			if (name in vars) {
				changed = true;
				return vars[name];
			}
			if (fb !== undefined) {
				changed = true;
				return fb.trim();
			}
			return m;
		}
	);
	return changed ? subst(out, vars, depth + 1) : out;
}

const hex2 = (h) => parseInt(h, 16);
function canonColours(v) {
	let s = v.replace(/#([0-9a-f]{3,8})\b/gi, (m, h) => {
		if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
		const a = h.length === 8 ? hex2(h.slice(6, 8)) : 255;
		return `C(${hex2(h.slice(0, 2))},${hex2(h.slice(2, 4))},${hex2(h.slice(4, 6))},${a})`;
	});
	s = s.replace(
		/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([^)]+?))?\s*\)/gi,
		(m, r, g, b, a) => {
			// Alpha as the 8-bit value browsers composite with (the minifier writes
			// `rgb(0 218 105 / .1)` as #00da691a — the same 8-bit alpha, 26).
			let al = a === undefined ? '1' : a.trim();
			if (/^[\d.]+%$/.test(al)) al = String(parseFloat(al) / 100);
			if (/^[\d.]+$/.test(al)) al = String(Math.round(+al * 255));
			return `C(${+r},${+g},${+b},${al})`;
		}
	);
	return s
		.replace(/\bwhite\b/g, 'C(255,255,255,1)')
		.replace(/\s+/g, ' ')
		.replace(/\s*,\s*/g, ',')
		.replace(/\(\s+/g, '(')
		.replace(/\s+\)/g, ')')
		.trim();
}

function ruleSet(cssList, vars) {
	const out = [];
	for (const css of cssList) {
		postcss.parse(css).walkRules((r) => {
			if (r.selector === ':root') return; // token definitions — compared via their uses
			const ctx = [];
			let p = r.parent;
			while (p && p.type !== 'root') {
				if (p.type === 'atrule')
					ctx.unshift(`@${p.name} ${p.params.replace(/svelte-[a-z0-9]+/g, 'svelte-H')}`);
				p = p.parent;
			}
			const sel = r.selector.replace(/svelte-[a-z0-9]+/g, 'svelte-H').replace(/\s+/g, ' ');
			const decls = [];
			r.each((d) => {
				if (d.type !== 'decl') return;
				const v = vars ? subst(d.value, vars) : d.value;
				decls.push(`${d.prop}:${canonColours(v)}${d.important ? '!' : ''}`);
			});
			out.push(`${ctx.join(' ')} ${sel} {${decls.join(';')}}`);
		});
	}
	return out;
}

/** css-diff: every compiled rule of build A must exist in build B (same
 *  selector/at-rule context, same declarations) once each build's :root custom
 *  properties are substituted and colours canonicalised (8-bit alpha, as the
 *  browser composites). Proves an unthemed build paints the same values
 *  everywhere, including components no screenshot reaches. */
function cssDiff(before, after) {
	const postcssMod = require('postcss');
	postcss = postcssMod;
	const A = cssFiles(before);
	const B = cssFiles(after);
	const ra = ruleSet(A, rootVars(A.join('\n'))).sort();
	const rb = ruleSet(B, rootVars(B.join('\n'))).sort();
	const count = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
	const ca = count(ra);
	const cb = count(rb);
	const onlyA = [];
	const onlyB = [];
	for (const [k, n] of ca) if ((cb.get(k) ?? 0) < n) onlyA.push(k);
	for (const [k, n] of cb) if ((ca.get(k) ?? 0) < n) onlyB.push(k);
	console.log(`A: ${ra.length} rules, B: ${rb.length} rules`);
	console.log(`only in A (${onlyA.length}):`);
	for (const x of onlyA) console.log('  - ' + x.slice(0, 400));
	console.log(`only in B (${onlyB.length}):`);
	for (const x of onlyB) console.log('  + ' + x.slice(0, 400));
	return onlyA.length + onlyB.length === 0 ? 0 : 1;
}

const [cmd, x, y] = process.argv.slice(2);
if (cmd === 'shoot' && x && y) {
	const only = arg('only');
	await shoot(x, y, Number(arg('port', '4173')), only ? only.split(',') : null);
} else if (cmd === 'css-diff' && x && y) {
	process.exit(cssDiff(x, y));
} else if (cmd === 'diff' && x && y) {
	process.exit(diff(x, y, arg('out')));
} else {
	console.error(
		'usage: theme-pixel-check.mjs shoot <buildDir> <outDir> | diff <dirA> <dirB> [--out dir]'
	);
	process.exit(2);
}
