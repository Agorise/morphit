/**
 * Move every inline executable <script> of the built pages into its own file,
 * so the site's Content-Security-Policy can be `script-src 'self'
 * 'wasm-unsafe-eval'` — no 'unsafe-inline', no hashes, no 'unsafe-eval'.
 *
 * WHY HERE. adapter-static writes, into every page, an inline bootstrap
 * script (the one that imports the app and calls kit.start). A CSP without
 * 'unsafe-inline' blocks it, and SvelteKit's own `kit.csp` cannot help a
 * static build served by nginx: it can only put per-page hashes in a <meta>
 * tag, while the HEADER (which nginx and BunkerWeb send, the same for every
 * page) would still have to allow inline script for those pages to run. So
 * the build moves each inline script into a content-addressed file
 *   /_app/immutable/boot/<first 20 hex of its SHA-256>.js
 * and replaces it with `<script src="…"></script>` at the same place. The
 * bootstrap uses `document.currentScript.parentElement`, which a classic,
 * parser-inserted external script provides exactly like the inline one did.
 *
 * Runs inside the build (apps/web/svelte.config.js wraps adapter-static),
 * BEFORE scripts/build-brand-slots.mjs records its byte offsets. Regenerates
 * the .gz / .br siblings of every page it changes, with adapter-static's
 * settings, and writes .gz / .br for the new files. FAILS the build if an
 * inline executable script or an inline event-handler attribute is left in
 * any page, so the strict header can never meet a page it would break.
 * Idempotent: a build with nothing inline (the release's prebuilt frontend)
 * is left untouched. Non-executable data blocks (JSON-LD,
 * type="application/json") are not scripts to the browser and stay inline.
 *
 * Standard Node only.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import { join, relative } from 'node:path';

export const BOOT_DIR = '_app/immutable/boot';

/**
 * Script types a browser executes (an absent type is JavaScript).
 * @param {string} attrs
 * @returns {boolean}
 */
function isExecutable(attrs) {
	const m = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
	if (m === null) return true;
	const t = (m[1] ?? '').toLowerCase();
	return t === 'module' || t === 'text/javascript' || t === 'application/javascript';
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
	/** @type {string[]} */
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...walk(full));
		else if (st.isFile()) out.push(full);
	}
	return out;
}

/**
 * Same parameters as @sveltejs/kit's builder.compress (adapter-static).
 * @param {string} file
 * @param {{ onlyIfPresent: boolean }} opts
 */
function compress(file, { onlyIfPresent }) {
	const buf = readFileSync(file);
	if (!onlyIfPresent || existsSync(`${file}.gz`)) {
		writeFileSync(`${file}.gz`, gzipSync(buf, { level: zc.Z_BEST_COMPRESSION }));
	}
	if (!onlyIfPresent || existsSync(`${file}.br`)) {
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

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const HANDLER_ATTR_RE = /<[a-z][^>]*\son[a-z]+\s*=/i;

/**
 * What a page still has that a `script-src 'self'` policy would block.
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptProblems(html) {
	/** @type {string[]} */
	const problems = [];
	for (const m of html.matchAll(SCRIPT_RE)) {
		const attrs = m[1] ?? '';
		const body = (m[2] ?? '').trim();
		if (/\bsrc\s*=/i.test(attrs)) continue;
		if (!isExecutable(attrs)) continue;
		if (body === '') continue;
		problems.push(`inline <script${attrs}> (${body.slice(0, 40)}…)`);
	}
	if (HANDLER_ATTR_RE.test(html.replace(SCRIPT_RE, '')))
		problems.push('inline event-handler attribute');
	return problems;
}

/**
 * Externalize the inline scripts of every .html page under `buildDir`.
 * Returns the number of pages changed and of script files written.
 * @param {string} buildDir
 * @param {(msg: string) => void} [log]
 */
export function externalizeInlineScripts(buildDir, log = console.log) {
	const pages = walk(buildDir).filter((f) => f.endsWith('.html'));
	const bootDir = join(buildDir, BOOT_DIR);
	const written = new Set();
	let changed = 0;
	for (const page of pages) {
		const before = readFileSync(page, 'utf8');
		const after = before.replace(SCRIPT_RE, (whole, attrs, body) => {
			if (/\bsrc\s*=/i.test(attrs) || !isExecutable(attrs) || body.trim() === '') return whole;
			const hash = createHash('sha256').update(body).digest('hex').slice(0, 20);
			const name = `${hash}.js`;
			if (!written.has(name)) {
				mkdirSync(bootDir, { recursive: true });
				const file = join(bootDir, name);
				writeFileSync(file, body);
				compress(file, { onlyIfPresent: false });
				written.add(name);
			}
			// A module script stays a module; a classic one stays classic (the
			// SvelteKit bootstrap needs document.currentScript).
			const type = /\btype\s*=\s*["']?module/i.test(attrs) ? ' type="module"' : '';
			return `<script${type} src="/${BOOT_DIR}/${name}"></script>`;
		});
		if (after !== before) {
			writeFileSync(page, after);
			compress(page, { onlyIfPresent: true });
			changed++;
		}
		const left = inlineScriptProblems(after);
		if (left.length > 0) {
			throw new Error(
				`[csp] ${relative(buildDir, page)} still has ${left.join('; ')} — the strict script-src would block it.`
			);
		}
	}
	log(
		`[csp] moved inline scripts out of ${changed} page(s) into ${written.size} file(s) under /${BOOT_DIR}/.`
	);
	return { pages: changed, files: written.size };
}
