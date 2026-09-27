#!/usr/bin/env node
/**
 * Morphit — per-instance brand SLOT map builder (post-prerender).
 *
 * WHY (docs/BRANDING.md). Every federated operator serves the SAME, byte-for-byte
 * canonical frontend (the on-chain build-integrity check depends on it), yet each
 * instance wants its OWN site name wherever the UI names the site ("Sign in to
 * Vigilante Trading") — while software mentions ("Run a Morphit node") stay put.
 * The brand therefore arrives at runtime; but a prerendered page is painted, read
 * by crawlers and used by no-JS visitors BEFORE any JavaScript runs, so the
 * prerendered HTML itself must carry the operator's brand. `morphit-ops branding
 * apply` rewrites it — and this script tells it exactly WHERE.
 *
 * WHAT. During prerender every SITE-brand slot is bracketed by an invisible
 * U+2060 WORD JOINER ("\u2060Morphit\u2060"; the locale `{brand}` / `{brand|Morphita}`
 * placeholders render that way while `building`, see src/lib/brand/brand.ts;
 * app.html writes the pair as the &#8288; entity). This script runs inside the
 * build itself — apps/web/svelte.config.js wraps adapter-static with it — and,
 * for every emitted page:
 *   1. stamps <html data-brand-name="Morphit" data-brand-beta="on"> on each
 *      prerendered page EXCEPT the root index.html (the SPA fallback shell — it
 *      is on the on-chain tamper manifest, so nothing may ever rewrite it, and a
 *      page without the stamp tells the client to fetch /brand/brand.json);
 *   2. records each bracketed slot — its offset in the FINAL text, its default
 *      form ("Morphit", "Morphita", "مورفیت"), and whether it sits in raw script /
 *      style text (JSON-LD) or in HTML — into build/.brand-slots.json;
 *   3. strips the markers, so the canonical HTML is clean (a Morphit instance
 *      that never re-brands serves exactly the text it always did);
 *   4. regenerates the .gz / .br siblings of every page it changed, with the
 *      same settings adapter-static uses (so a build stays reproducible).
 * It FAILS the build if a marker is left over or unpaired anywhere, so a slot
 * can never silently leak an invisible character or be lost.
 *
 * `.brand-slots.json` is a dotfile: it travels with build/ (bare-metal copy,
 * Docker bind mount, release tarball) but nginx never serves it (dotfiles are
 * denied). It is hashed into verify.json like every other build file.
 *
 * Idempotent: a build with no markers left (e.g. the release's prebuilt
 * frontend) and an existing map is left untouched.
 *
 * Standard Node only (no deps), like build-verify-json.mjs.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = resolve(process.argv[2] ?? resolve(__dirname, '..', 'apps', 'web', 'build'));

export const MAP_SCHEMA = 1;
/** Marker as a raw character or as the HTML entity app.html uses. */
const MARK = '(?:\\u2060|&#8288;)';
/** A bracketed slot: the DEFAULT form between two markers — the software
 *  name or a locale's inflected / transliterated form of it ("Morphit",
 *  "Morphita", "Morphicie", "مورفیت"; `{brand|…}` in the locale JSON). Any text
 *  without markup characters, up to 64 characters. */
export const SLOT_FORM_SOURCE = '[^\\u2060<>&"\\n]{1,64}';
const SLOT_RE = new RegExp(`${MARK}(${SLOT_FORM_SOURCE})${MARK}`, 'g');
const ANY_MARK_RE = /\u2060|&#8288;/;
/** The data attributes a canonical page is stamped with. `morphit-ops branding
 *  apply` rewrites exactly this string (keep in sync with ops-cli branding.ts). */
export const CANONICAL_HTML_ATTRS = 'data-brand-name="Morphit" data-brand-beta="on"';

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...walk(full));
		else if (st.isFile()) out.push(full);
	}
	return out;
}

/** Same parameters as @sveltejs/kit's builder.compress (adapter-static). */
function recompress(file) {
	const buf = readFileSync(file);
	if (existsSync(`${file}.gz`)) {
		writeFileSync(`${file}.gz`, gzipSync(buf, { level: zc.Z_BEST_COMPRESSION }));
	}
	if (existsSync(`${file}.br`)) {
		writeFileSync(
			`${file}.br`,
			brotliCompressSync(buf, {
				params: {
					[zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_TEXT,
					[zc.BROTLI_PARAM_QUALITY]: zc.BROTLI_MAX_QUALITY,
					[zc.BROTLI_PARAM_SIZE_HINT]: buf.length
				}
			})
		);
	}
}

/** Offsets (in the given text) of raw-text regions: <script>…</script> and
 *  <style>…</style> bodies, where entities are NOT decoded. */
function rawRegions(text) {
	const regions = [];
	const re = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
	let m;
	while ((m = re.exec(text)) !== null) {
		const bodyStart = m.index + m[0].indexOf('>') + 1;
		regions.push([bodyStart, bodyStart + m[2].length]);
	}
	return regions;
}

/**
 * Process one page's text. Returns { text, slots } where slots are
 * [offset, length, form, ctx] in the returned (clean) text; ctx is 'html' or
 * 'raw'. Pure — exported for the smoke test.
 */
export function processPage(input, { stamp }) {
	let text = input;
	// A prerendered REDIRECT stub (SvelteKit writes `<script>…</script><meta
	// http-equiv="refresh">` with no <html>) has nothing to brand: leave it.
	if (stamp && !/<html\b/i.test(text) && !ANY_MARK_RE.test(text)) return { text, slots: [] };
	if (stamp) {
		const m = /<html\b[^>]*>/i.exec(text);
		if (!m) throw new Error('no <html> tag to stamp');
		if (!m[0].includes('data-brand-name=')) {
			const tag = m[0].replace(/>$/, ` ${CANONICAL_HTML_ATTRS}>`);
			text = text.slice(0, m.index) + tag + text.slice(m.index + m[0].length);
		}
	}
	const raw = rawRegions(text);
	const inRaw = (pos) => raw.some(([a, b]) => pos >= a && pos < b);
	const slots = [];
	let out = '';
	let last = 0;
	let m;
	SLOT_RE.lastIndex = 0;
	while ((m = SLOT_RE.exec(text)) !== null) {
		out += text.slice(last, m.index);
		const form = m[1];
		slots.push([out.length, form.length, form, inRaw(m.index) ? 'raw' : 'html']);
		out += form;
		last = m.index + m[0].length;
	}
	out += text.slice(last);
	if (ANY_MARK_RE.test(out)) {
		const at = out.search(ANY_MARK_RE);
		throw new Error(
			`unpaired brand-slot marker near: ${JSON.stringify(out.slice(Math.max(0, at - 40), at + 40))}`
		);
	}
	return { text: out, slots };
}

/**
 * Post-process an adapter-static build in place (see the header). Throws on a
 * leftover / unpaired marker. Called by the adapter wrapper in
 * apps/web/svelte.config.js (so EVERY `vite build` — npm run build, a bare
 * `vite build`, the release — emits a clean build + slot map) and again, as a
 * no-op safety net, by apps/web/scripts/build-shipped-guard.mjs.
 */
export function processBuild(buildDir, log = console.log) {
	const mapPath = join(buildDir, '.brand-slots.json');
	if (!existsSync(buildDir)) {
		throw new Error(`${buildDir} does not exist — run vite build first.`);
	}
	const files = walk(buildDir);
	const htmlFiles = files.filter((f) => f.endsWith('.html'));
	const anyMarked = htmlFiles.some((f) => ANY_MARK_RE.test(readFileSync(f, 'utf8')));
	if (!anyMarked && existsSync(mapPath)) {
		log('[brand-slots] no markers left and a slot map exists — already processed.');
		return;
	}
	const map = { schema: MAP_SCHEMA, attrs: CANONICAL_HTML_ATTRS, files: {} };
	let slotCount = 0;
	for (const abs of htmlFiles.sort()) {
		const rel = relative(buildDir, abs).split('\\').join('/');
		const before = readFileSync(abs, 'utf8');
		// index.html is the SPA fallback AND on the on-chain tamper manifest:
		// strip its markers (canonical bytes must be clean) but never stamp it and
		// never list it — `morphit-ops branding apply` must not touch it.
		const isShell = rel === 'index.html';
		let result;
		try {
			result = processPage(before, { stamp: !isShell });
		} catch (err) {
			throw new Error(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
		}
		const { text, slots } = result;
		if (text !== before) {
			writeFileSync(abs, text);
			recompress(abs);
		}
		if (!isShell && (slots.length > 0 || text.includes(CANONICAL_HTML_ATTRS))) {
			map.files[rel] = slots;
			slotCount += slots.length;
		}
	}
	// Belt and braces: no marker may survive in ANY emitted text asset.
	for (const abs of files) {
		if (!/\.(html|js|mjs|css|json|xml|txt|svg|webmanifest)$/.test(abs)) continue;
		if (abs === mapPath) continue;
		if (/\u2060/.test(readFileSync(abs, 'utf8'))) {
			throw new Error(
				`stray U+2060 in ${relative(buildDir, abs)} — a brand slot leaked into a non-page asset.`
			);
		}
	}
	writeFileSync(mapPath, JSON.stringify(map) + '\n');
	log(
		`[brand-slots] wrote ${relative(process.cwd(), mapPath)} — ${slotCount} brand slots across ${Object.keys(map.files).length} pages.`
	);
}

function main() {
	try {
		processBuild(BUILD_DIR);
	} catch (err) {
		console.error(`[brand-slots] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
