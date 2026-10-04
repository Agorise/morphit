#!/usr/bin/env node
/**
 * Does a built frontend name its BUILD origin anywhere an instance cannot
 * rewrite it? (no instance may serve morphit.io's address in its pages,
 * and a hidden-only instance no clearnet address at all.)
 *
 * Every page and site file may name the build origin ONLY at a place recorded
 * in build/.origin-slots.json (scripts/origin-slots.mjs), because those are the
 * only places `origin-slots.mjs apply` rewrites to the instance's own origin.
 * Anything else — a hard-coded `<meta content="https://morphit.io/…">` in
 * app.html, say — reaches every instance unchanged, and in index.html it cannot
 * be rewritten at all (it is on the on-chain integrity manifest).
 *
 * Usage: node origin-leak-scan.mjs <buildDir>   (after `origin-slots.mjs record`)
 * Prints `✓ all N pages …` or every leak with its file and context, and exits
 * non-zero on a leak.
 *
 * Standard Node only.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loaded by URL: origin-slots.mjs carries no type declarations.
/** @type {{ LITERAL_FILES: string[], ORIGIN_SLOTS_FILE: string }} */
const { LITERAL_FILES, ORIGIN_SLOTS_FILE } = await import(
	new URL('./origin-slots.mjs', import.meta.url).href
);

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
	/** @type {string[]} */
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = lstatSync(full);
		if (st.isDirectory()) out.push(...walk(full));
		else if (st.isFile()) out.push(full);
	}
	return out;
}

/**
 * Every place `text` names `host` as a URL authority (http:, https: or
 * protocol-relative), as [start, matched text].
 * @param {string} text
 * @param {string} host
 * @returns {Array<[number, string]>}
 */
export function hostUrlsIn(text, host) {
	const re = new RegExp(
		`(?:https?:)?//${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9.-])`,
		'gi'
	);
	/** @type {Array<[number, string]>} */
	const out = [];
	for (const m of text.matchAll(re)) out.push([m.index ?? 0, m[0]]);
	return out;
}

/**
 * The places in `buildDir` that name the build origin outside a recorded slot.
 * @param {string} buildDir
 * @returns {{ origin: string, pages: number, leaks: Array<{ file: string, at: number, context: string }> }}
 */
export function originLeaks(buildDir) {
	const mapPath = join(buildDir, ORIGIN_SLOTS_FILE);
	if (!existsSync(mapPath)) {
		throw new Error(`${mapPath} missing — run origin-slots.mjs record first.`);
	}
	const map = JSON.parse(readFileSync(mapPath, 'utf8'));
	const origin = String(map.build_origin);
	const host = new URL(origin).host;
	/** @type {Record<string, Array<[number, number]>>} */
	const slotsByFile = map.files ?? {};
	const files = walk(buildDir)
		.map((abs) => relative(buildDir, abs).split('\\').join('/'))
		.filter((rel) => rel.endsWith('.html') || LITERAL_FILES.includes(rel));
	/** @type {Array<{ file: string, at: number, context: string }>} */
	const leaks = [];
	for (const rel of files) {
		const text = readFileSync(join(buildDir, rel), 'utf8');
		const slots = slotsByFile[rel] ?? [];
		for (const [at] of hostUrlsIn(text, host)) {
			const inSlot = slots.some(([s, len]) => at >= s && at < s + len);
			if (!inSlot) {
				leaks.push({
					file: rel,
					at,
					context: text.slice(Math.max(0, at - 50), at + 50).replace(/\s+/g, ' ')
				});
			}
		}
	}
	return { origin, pages: files.length, leaks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const dir = process.argv[2];
	if (!dir) {
		console.error('usage: origin-leak-scan.mjs <buildDir>');
		process.exit(2);
	}
	const { origin, pages, leaks } = originLeaks(dir);
	if (leaks.length === 0) {
		console.log(`✓ all ${pages} pages name ${origin} only inside recorded origin slots`);
	} else {
		const files = new Set(leaks.map((l) => l.file));
		console.log(
			`✗ ${leaks.length} hard-coded ${origin} URL(s) outside origin slots, in ${files.size} file(s):`
		);
		const shown = new Set();
		for (const l of leaks) {
			const key = `${l.context}`;
			if (shown.has(key) && shown.size > 20) continue;
			shown.add(key);
			if (shown.size <= 25) console.log(`  ${l.file}@${l.at}: …${l.context}…`);
		}
		const sample = [...files].slice(0, 10).join(', ');
		console.log(`  files: ${sample}${files.size > 10 ? ', …' : ''}`);
		process.exit(1);
	}
}
