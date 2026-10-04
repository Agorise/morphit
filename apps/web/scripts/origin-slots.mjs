#!/usr/bin/env node
/**
 * Morphit — per-instance site ORIGIN for the prebuilt frontend.
 *
 * WHY. Every instance serves the same prebuilt pages, but the absolute URLs in
 * them — canonical, hreflang, og:url, og:image, JSON-LD, sitemap.xml,
 * robots.txt, llms.txt — must name THAT instance: never morphit.io on someone
 * else's site, and no clearnet URL at all on a hidden-only instance.
 *
 * HOW.
 *   record (build time, apps/web/scripts/build-shipped-guard.mjs): prerendered
 *     pages write the build origin wrapped in U+2063 INVISIBLE SEPARATOR
 *     markers (src/lib/seo/urls.ts siteOrigin). This records each marked place
 *     — and every occurrence of the build origin in sitemap.xml, robots.txt,
 *     llms.txt and llms-full.txt — into build/.origin-slots.json, strips the
 *     markers (shifting the brand-slot offsets in build/.brand-slots.json to
 *     match) and regenerates the .gz/.br siblings. It fails the build if a
 *     marker sits anywhere else (the root index.html, _app code, any other
 *     asset) or is unpaired.
 *   apply (install / upgrade, morphit-ops): rewrites every recorded place with
 *     the instance's origin (or, with no origin, drops it, leaving root-relative
 *     URLs — except in robots.txt and sitemap.xml, which then drop their
 *     URLs instead: see HELD_DIR), shifts the brand-slot offsets, regenerates .gz/.br, and refreshes
 *     the served verify.json's full-file manifest for every file it changed,
 *     plus an `instance_origin` disclosure. It never writes a file on the
 *     on-chain integrity manifest (index.html, service-worker*, _app/**).
 *
 * ORDER WITH BRANDING. Brand slots are offsets into the canonical page, which
 * this step changes. Apply the origin to an UNBRANDED build: on a fresh build
 * before `applyBranding`, or after resetting branding. `apply` refuses while
 * branding holds saved originals of this build.
 *
 * Interrupted apply: the planned result is written to .origin-slots.pending.json
 * before any page changes, and the next `apply` finishes it.
 *
 * CLI:
 *   node origin-slots.mjs record <buildDir>
 *   node origin-slots.mjs apply  <buildDir> <origin | ->     ("-": no origin)
 *   node origin-slots.mjs status <buildDir>
 * `apply` prints one JSON line: {"changed":bool,"origin":…,"touched":[…]}
 * (touched: build-relative paths it rewrote, verify.json included).
 *
 * Standard Node only (no deps).
 */
import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORIGIN_SLOTS_FILE = '.origin-slots.json';
export const ORIGIN_SLOTS_PENDING = '.origin-slots.pending.json';
export const ORIGIN_SLOTS_SCHEMA = 1;
const BRAND_SLOTS_FILE = '.brand-slots.json';
const MARK = '\u2063';
/**
 * Files whose URLs must be absolute (the sitemap protocol; robots.txt's
 * Sitemap directive). Applied with NO origin ("-"), such a file is served in a
 * cleaned form — robots.txt without its Sitemap line, sitemap.xml without
 * URL entries — and its slot form (every origin slot empty) is kept, not
 * served, under HELD_DIR, so a later apply with an origin restores it.
 */
export const HELD_DIR = '.origin-held';
const NO_ORIGIN_FORMS = {
	'robots.txt': (text) =>
		text.replace(/^[ \t]*Sitemap:[ \t]*(?!https?:\/\/)[^\r\n]*(?:\r?\n|$)/gim, ''),
	'sitemap.xml': (text) =>
		text.replace(/[ \t]*<url>[\s\S]*?<\/url>[ \t]*(?:\r?\n)?/g, (block) =>
			/<loc>\s*https?:\/\//.test(block) ? block : ''
		)
};

/** Static files that name the site by its full origin. */
export const LITERAL_FILES = ['robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt'];
/** An origin as the build or an operator gives it: scheme + host (+ port). */
const ORIGIN_RE =
	/^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const TEXT_ASSET_RE = /\.(html|js|mjs|css|json|xml|txt|svg|webmanifest)$/;

/** Files no per-instance step may write: the on-chain integrity manifest
 *  (index.html, service-worker*, _app/immutable/entry/*), the rest of the
 *  content-addressed _app code, and verify.json (refreshed separately). */
export function isProtectedPath(rel) {
	const r = rel.replace(/^\/+/, '');
	return (
		r === '' ||
		r.startsWith('index.html') ||
		r.startsWith('service-worker') ||
		r === '_app' ||
		r.startsWith('_app/') ||
		r.startsWith('verify.json') ||
		r.split('/').some((seg) => seg === '..' || seg === '.')
	);
}

/** The origin an operator configured, normalized (lower-case, no trailing
 *  slash), or null when there is none. Throws on anything else. */
export function normalizeOrigin(raw) {
	if (raw === null || raw === undefined) return null;
	const s = String(raw).trim().replace(/\/+$/, '').toLowerCase();
	if (s === '' || s === '-') return null;
	if (!ORIGIN_RE.test(s)) {
		throw new Error(`not an origin (scheme://host[:port], nothing after): ${JSON.stringify(raw)}`);
	}
	return s;
}

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = lstatSync(full);
		if (st.isDirectory()) out.push(...walk(full));
		else if (st.isFile()) out.push(full);
	}
	return out;
}

function relOf(buildDir, abs) {
	return relative(buildDir, abs).split('\\').join('/');
}

function readJson(path) {
	return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function atomicWrite(path, data) {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, data);
	renameSync(tmp, path);
}

/** Same parameters as @sveltejs/kit's builder.compress (adapter-static). */
function recompress(path) {
	const buf = readFileSync(path);
	if (existsSync(`${path}.gz`)) {
		atomicWrite(`${path}.gz`, gzipSync(buf, { level: zc.Z_BEST_COMPRESSION }));
	}
	if (existsSync(`${path}.br`)) {
		atomicWrite(
			`${path}.br`,
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

function siblingsOf(buildDir, rel) {
	return ['.gz', '.br'].filter((s) => existsSync(join(buildDir, rel + s))).map((s) => rel + s);
}

/** Brand-slot offsets after a page's text changed at `edits` ([offset in the
 *  old text, old length, new length], ascending, non-overlapping). */
function shiftSlots(slots, edits) {
	return slots.map((slot) => {
		let delta = 0;
		for (const [at, oldLen, newLen] of edits) {
			if (at + oldLen <= slot[0]) delta += newLen - oldLen;
			else if (at < slot[0] + slot[1] && slot[0] < at + oldLen) {
				throw new Error(`a brand slot at ${slot[0]} overlaps an origin slot at ${at}`);
			}
		}
		return [slot[0] + delta, ...slot.slice(1)];
	});
}

function shiftBrandMap(brandMap, rel, edits) {
	if (brandMap === null) return;
	for (const key of ['files', 'theme_files']) {
		const slots = brandMap[key]?.[rel];
		if (slots) brandMap[key][rel] = shiftSlots(slots, edits);
	}
}

/** Occurrences of `origin` used as an origin (not followed by more host). */
function literalSlots(text, origin) {
	const out = [];
	let at = text.indexOf(origin);
	while (at >= 0) {
		const next = text[at + origin.length];
		if (next === undefined || !/[A-Za-z0-9.\-:]/.test(next)) out.push([at, origin.length]);
		at = text.indexOf(origin, at + origin.length);
	}
	return out;
}

/**
 * Strip the marked origins of one page. Returns { text, slots, edits, origins }
 * (slots: [offset, length] in the returned text; edits: for brand-slot
 * shifting). Pure — exported for the test.
 */
export function stripMarkedOrigins(input) {
	const slots = [];
	const edits = [];
	const origins = new Set();
	let out = '';
	let pos = 0;
	for (;;) {
		const open = input.indexOf(MARK, pos);
		if (open < 0) break;
		const close = input.indexOf(MARK, open + 1);
		const inner = close < 0 ? '' : input.slice(open + 1, close);
		if (close < 0 || !ORIGIN_RE.test(inner)) {
			throw new Error(
				`unpaired or malformed origin marker near: ${JSON.stringify(input.slice(Math.max(0, open - 40), open + 60))}`
			);
		}
		out += input.slice(pos, open);
		slots.push([out.length, inner.length]);
		edits.push([open, inner.length + 2, inner.length]);
		origins.add(inner);
		out += inner;
		pos = close + 1;
	}
	out += input.slice(pos);
	return { text: out, slots, edits, origins: [...origins] };
}

/**
 * Build time: record and strip (see the header). Idempotent: a build whose
 * map exists and whose pages carry no marker is left alone. `buildOrigin` is
 * used for the static files when no page carries a marker.
 */
export function recordOriginSlots(buildDir, buildOrigin, log = console.log) {
	if (!existsSync(buildDir)) throw new Error(`${buildDir} does not exist — run vite build first.`);
	const mapPath = join(buildDir, ORIGIN_SLOTS_FILE);
	const files = walk(buildDir);
	const marked = files.filter(
		(f) => TEXT_ASSET_RE.test(f) && readFileSync(f, 'utf8').includes(MARK)
	);
	if (marked.length === 0 && existsSync(mapPath)) {
		log('[origin-slots] no markers left and a slot map exists — already processed.');
		return readJson(mapPath);
	}
	for (const abs of marked) {
		const rel = relOf(buildDir, abs);
		if (!rel.endsWith('.html') || isProtectedPath(rel)) {
			throw new Error(
				`stray U+2063 in ${rel} — a marked site origin reached a file no instance may rewrite.`
			);
		}
	}
	const brandPath = join(buildDir, BRAND_SLOTS_FILE);
	const brandMap = readJson(brandPath);
	const map = {
		schema: ORIGIN_SLOTS_SCHEMA,
		build_origin: null,
		applied_origin: null,
		files: {}
	};
	const seen = new Set();
	for (const abs of marked.sort()) {
		const rel = relOf(buildDir, abs);
		let page;
		try {
			page = stripMarkedOrigins(readFileSync(abs, 'utf8'));
		} catch (err) {
			throw new Error(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
		}
		page.origins.forEach((o) => seen.add(o));
		writeFileSync(abs, page.text);
		recompress(abs);
		shiftBrandMap(brandMap, rel, page.edits);
		map.files[rel] = page.slots;
	}
	if (seen.size > 1)
		throw new Error(`pages were built for several origins: ${[...seen].join(', ')}`);
	const origin = normalizeOrigin([...seen][0] ?? buildOrigin);
	if (origin === null) throw new Error('no build origin');
	map.build_origin = origin;
	map.applied_origin = origin;
	for (const rel of LITERAL_FILES) {
		const abs = join(buildDir, rel);
		if (!existsSync(abs)) continue;
		const slots = literalSlots(readFileSync(abs, 'utf8'), origin);
		if (slots.length > 0) map.files[rel] = slots;
	}
	if (brandMap !== null) writeFileSync(brandPath, JSON.stringify(brandMap) + '\n');
	writeFileSync(mapPath, JSON.stringify(map) + '\n');
	const count = Object.values(map.files).reduce((n, s) => n + s.length, 0);
	log(
		`[origin-slots] wrote ${ORIGIN_SLOTS_FILE} — ${count} origin slots (${origin}) across ${Object.keys(map.files).length} files.`
	);
	return map;
}

/** Same identity as morphit-ops branding uses for a canonical build. */
function brandingBuildId(buildDir) {
	const h = createHash('sha256');
	for (const rel of [BRAND_SLOTS_FILE, 'index.html']) {
		const p = join(buildDir, rel);
		h.update(existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
	}
	return h.digest('hex');
}

function assertNotBranded(buildDir) {
	const state = readJson(join(dirname(buildDir), '.brand-pristine', 'state.json'));
	if (
		state !== null &&
		state.build_id === brandingBuildId(buildDir) &&
		(state.modified?.length ?? 0) + (state.added?.length ?? 0) > 0
	) {
		throw new Error(
			'this build is branded; reset the branding first, apply the origin, then apply the branding again.'
		);
	}
}

/** The edits that move every slot of a file from `from` to `to`; the new
 *  slots; and the new text when `text` is at `from` (null if it is not). */
function planFile(text, slots, from, to) {
	const edits = [];
	const next = [];
	let delta = 0;
	let out = '';
	let pos = 0;
	let atFrom = true;
	for (const [at, len] of slots) {
		if (len !== from.length || text.slice(at, at + len) !== from) atFrom = false;
		edits.push([at, len, to.length]);
		next.push([at + delta, to.length]);
		out += text.slice(pos, at) + to;
		pos = at + len;
		delta += to.length - len;
	}
	out += text.slice(pos);
	return { edits, next, text: atFrom ? out : null };
}

function slotsAt(text, slots, origin) {
	return slots.every(([at, len]) => len === origin.length && text.slice(at, at + len) === origin);
}

function sha256Hex(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

function refreshVerifyJson(buildDir, rels, map) {
	const path = join(buildDir, 'verify.json');
	if (!existsSync(path)) return false;
	const doc = JSON.parse(readFileSync(path, 'utf8'));
	const hm = doc.hash_manifest ?? {};
	for (const rel of rels) {
		const p = join(buildDir, rel);
		if (existsSync(p)) hm[rel] = sha256Hex(readFileSync(p));
		else delete hm[rel];
	}
	const sorted = {};
	for (const k of Object.keys(hm).sort()) sorted[k] = hm[k];
	doc.hash_manifest = sorted;
	if (map.applied_origin !== map.build_origin) {
		doc.instance_origin = {
			origin: map.applied_origin === '' ? null : map.applied_origin,
			note: "The absolute URLs in these files name this instance's own origin instead of the build's. The on-chain release manifest (index.html, service-worker, _app entry) is never modified.",
			files: Object.keys(map.files).sort()
		};
	} else {
		delete doc.instance_origin;
	}
	atomicWrite(path, JSON.stringify(doc, null, 2) + '\n');
	return true;
}

/**
 * Install / upgrade time: point every recorded place at `origin` (null: no
 * origin — the URLs become root-relative). Returns
 * { changed, origin, touched } — touched: build-relative paths of every
 * rewritten file, verify.json included, for mirroring into a separate web root.
 */
export function applyInstanceOrigin(buildDir, originInput) {
	const origin = normalizeOrigin(originInput);
	const target = origin ?? '';
	const mapPath = join(buildDir, ORIGIN_SLOTS_FILE);
	const pendingPath = join(buildDir, ORIGIN_SLOTS_PENDING);
	const brandPath = join(buildDir, BRAND_SLOTS_FILE);
	let pending = readJson(pendingPath);
	const current = readJson(mapPath);
	if (current === null) return { changed: false, origin, touched: [], reason: 'no-map' };
	if (pending === null && current.applied_origin === target) {
		return { changed: false, origin, touched: [] };
	}
	for (const rel of Object.keys(current.files)) {
		if (isProtectedPath(rel))
			throw new Error(`${ORIGIN_SLOTS_FILE} lists ${rel}, which is never rewritten`);
	}
	assertNotBranded(buildDir);

	if (pending !== null && pending.to?.applied_origin !== target) {
		// An earlier apply to another origin was interrupted: finish it first.
		applyInstanceOrigin(buildDir, pending.to.applied_origin || null);
		return applyInstanceOrigin(buildDir, origin);
	}
	const from = pending?.from ?? current;
	const brandMap = pending?.brand ?? readJson(brandPath);
	const plans = new Map();
	const nextMap = { ...from, applied_origin: target, files: {} };
	const heldRel = (rel) => `${HELD_DIR}/${rel}`;
	for (const [rel, slots] of Object.entries(from.files)) {
		// The file in slot form: its held copy while one exists (served cleaned).
		const abs = existsSync(join(buildDir, heldRel(rel)))
			? join(buildDir, heldRel(rel))
			: join(buildDir, rel);
		if (!existsSync(abs)) throw new Error(`${rel} is missing`);
		const text = readFileSync(abs, 'utf8');
		const plan = { ...planFile(text, slots, from.applied_origin, target), current: text };
		if (plan.text === null && !slotsAt(text, plan.next, target)) {
			throw new Error(
				`${rel} no longer matches ${ORIGIN_SLOTS_FILE} (expected ${from.applied_origin || 'no origin'} at every slot)`
			);
		}
		plans.set(rel, plan);
		nextMap.files[rel] = plan.next;
		if (pending === null) shiftBrandMap(brandMap, rel, plan.edits);
	}
	if (pending === null) {
		pending = { from, to: nextMap, brand: brandMap };
		atomicWrite(pendingPath, JSON.stringify(pending) + '\n');
	}
	// Every recorded file counts as touched, including any an interrupted run
	// already rewrote (its web-root copy and manifest entry may be stale).
	const touched = [];
	for (const [rel, plan] of plans) {
		const abs = join(buildDir, rel);
		const held = join(buildDir, heldRel(rel));
		// plan.text null: rewritten before an interruption (its .gz/.br may not be).
		const slotForm = plan.text ?? plan.current;
		const clean = target === '' ? NO_ORIGIN_FORMS[rel] : undefined;
		if (clean !== undefined) {
			// Held copy first, then the served file: an interruption leaves the
			// held copy as the file's slot form either way.
			mkdirSync(dirname(held), { recursive: true });
			atomicWrite(held, slotForm);
			atomicWrite(abs, clean(slotForm));
			touched.push(heldRel(rel));
		} else {
			atomicWrite(abs, slotForm);
			if (existsSync(held)) {
				rmSync(held, { force: true });
				touched.push(heldRel(rel));
			}
		}
		recompress(abs);
		touched.push(rel, ...siblingsOf(buildDir, rel));
	}
	if (target !== '') rmSync(join(buildDir, HELD_DIR), { recursive: true, force: true });
	if (pending.brand !== null) {
		atomicWrite(brandPath, JSON.stringify(pending.brand) + '\n');
		touched.push(BRAND_SLOTS_FILE);
	}
	atomicWrite(mapPath, JSON.stringify(pending.to) + '\n');
	touched.push(ORIGIN_SLOTS_FILE);
	if (refreshVerifyJson(buildDir, touched, pending.to)) touched.push('verify.json');
	rmSync(pendingPath, { force: true });
	return { changed: true, origin, touched: [...new Set(touched)].sort() };
}

function main(argv) {
	const [cmd, dir, originArg] = argv;
	const buildDir = resolve(dir ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'build'));
	if (cmd === 'record') {
		recordOriginSlots(buildDir, process.env.MORPHIT_SITE_ORIGIN || 'https://morphit.io');
	} else if (cmd === 'apply') {
		if (originArg === undefined)
			throw new Error('usage: origin-slots.mjs apply <buildDir> <origin|->');
		console.log(JSON.stringify(applyInstanceOrigin(buildDir, originArg)));
	} else if (cmd === 'status') {
		const map = readJson(join(buildDir, ORIGIN_SLOTS_FILE));
		console.log(
			JSON.stringify(
				map === null
					? { recorded: false }
					: {
							recorded: true,
							build_origin: map.build_origin,
							applied_origin: map.applied_origin === '' ? null : map.applied_origin,
							pending: existsSync(join(buildDir, ORIGIN_SLOTS_PENDING))
						}
			)
		);
	} else {
		throw new Error('usage: origin-slots.mjs record|apply|status <buildDir> [origin|-]');
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error(`[origin-slots] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
