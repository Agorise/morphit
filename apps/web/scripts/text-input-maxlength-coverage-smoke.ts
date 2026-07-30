/**
 * text-input-maxlength-coverage-smoke
 * ───────────────────────────────────
 * Asserts that EVERY free-text entry control in the web app —
 * `<textarea>` and `<input>` of a text-entry type — carries a
 * `maxlength` attribute.
 *
 * WHY (defense-in-depth, not the primary control):
 *   The authoritative length/format enforcement lives in the JS
 *   validators (validateDisplayName/validateShortBio, the URL
 *   validators, the op-schema Zod, the account-name regex) AND in
 *   the indexer's server-side mirror — a hand-crafted broadcast that
 *   skips the form is still rejected on-chain.  But the HTML
 *   `maxlength` is a cheap first-line backstop that (a) gives the
 *   user immediate feedback, and (b) stops a pathological multi-MB
 *   paste from ever sitting in the DOM / reaching a validator.  This
 *   smoke makes that backstop a standing invariant so new fields
 *   can't silently ship without it (cp350 — the site-wide field
 *   audit that added maxlength to 23 previously-unbounded fields).
 *
 * SCOPE:
 *   Text-entry types that REQUIRE maxlength:
 *     text, search, tel, url, email, password, (no type → text), textarea
 *   Types where maxlength is a no-op and is correctly OMITTED:
 *     checkbox, radio, file, range, color, number, date, datetime-local,
 *     month, week, time, submit, button, hidden, reset, image
 *
 * Comments are stripped before scanning so a `<input>` mentioned in a
 * JSDoc/HTML comment (e.g. FocusedField's doc block) is not counted.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_ROOT = join(REPO_ROOT, 'apps', 'web', 'src');

const IGNORE_DIRS = new Set(['node_modules', '.svelte-kit', 'dist', 'build']);

/** Input types where `maxlength` has no effect — correctly omitted. */
const NON_TEXT_TYPES = new Set([
	'checkbox',
	'radio',
	'file',
	'range',
	'color',
	'number',
	'date',
	'datetime-local',
	'month',
	'week',
	'time',
	'submit',
	'button',
	'hidden',
	'reset',
	'image'
]);

/**
 * Intentional exceptions (rel path + a short reason). Empty by design —
 * if a real exception ever arises, add it here WITH a reason so the
 * waiver is reviewable, never by silently dropping the check.
 */
const ALLOW_LIST: ReadonlyMap<string, string> = new Map([]);

interface Miss {
	readonly file: string;
	readonly line: number;
	readonly tag: string;
	readonly type: string;
}

/** Strip HTML comments and JS block comments so tag mentions inside
 *  documentation/comments are not treated as real controls. */
function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** From the index of a `<input`/`<textarea` match, return the full
 *  opening-tag text up to the matching top-level `>` — skipping `>`
 *  that appear inside `{...}` Svelte expressions or quoted strings. */
function readOpeningTag(src: string, from: number): string {
	let i = from;
	let brace = 0;
	let quote: string | null = null;
	while (i < src.length) {
		const c = src[i]!;
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === '{') {
			brace++;
		} else if (c === '}') {
			if (brace > 0) brace--;
		} else if (c === '>' && brace === 0) {
			return src.slice(from, i + 1);
		}
		i++;
	}
	return src.slice(from, Math.min(from + 400, src.length));
}

function scanFile(rel: string, raw: string, misses: Miss[]): number {
	const src = stripComments(raw);
	const re = /<(input|textarea)\b/gi;
	let m: RegExpExecArray | null;
	let count = 0;
	while ((m = re.exec(src)) !== null) {
		const tagName = m[1]!.toLowerCase();
		const tag = readOpeningTag(src, m.index);
		// Resolve the input type (textarea is always text-entry).
		let type = 'text';
		if (tagName === 'input') {
			const tm = tag.match(/\btype\s*=\s*["']([a-zA-Z-]+)["']/);
			// A dynamic `type={...}` can't be resolved statically; treat
			// as text-entry (require maxlength) — the conservative choice.
			type = tm ? tm[1]!.toLowerCase() : 'text';
		}
		if (NON_TEXT_TYPES.has(type)) continue;
		count++;
		if (/\bmaxlength\b/i.test(tag)) continue;
		const line = src.slice(0, m.index).split('\n').length;
		misses.push({ file: rel, line, tag: tagName, type });
	}
	return count;
}

function walk(dir: string, cb: (rel: string, content: string) => void): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			if (IGNORE_DIRS.has(entry)) continue;
			walk(full, cb);
		} else if (st.isFile() && entry.endsWith('.svelte')) {
			const rel = relative(REPO_ROOT, full);
			if (ALLOW_LIST.has(rel)) continue;
			let content: string;
			try {
				content = readFileSync(full, 'utf8');
			} catch {
				continue;
			}
			cb(rel, content);
		}
	}
}

console.log('');
console.log('── text-input-maxlength-coverage smoke ─────────────────');
console.log('');

const misses: Miss[] = [];
let textEntryFields = 0;
let filesScanned = 0;
walk(SCAN_ROOT, (rel, content) => {
	filesScanned++;
	textEntryFields += scanFile(rel, content, misses);
});

const scenarios = [
	{
		name: 'every text-entry <input>/<textarea> has a maxlength attribute',
		ok: misses.length === 0
	},
	{
		name: 'scan covered at least one .svelte file and one text-entry field',
		ok: filesScanned > 0 && textEntryFields > 0
	},
	{
		name: 'non-text input types are correctly excluded from the requirement',
		ok: NON_TEXT_TYPES.has('number') &&
			NON_TEXT_TYPES.has('time') &&
			NON_TEXT_TYPES.has('checkbox') &&
			NON_TEXT_TYPES.has('radio') &&
			NON_TEXT_TYPES.has('file')
	}
];

let passed = 0;
let failed = 0;
const failures: string[] = [];
for (const s of scenarios) {
	if (s.ok) passed++;
	else {
		failed++;
		failures.push(`  ✗ ${s.name}`);
	}
}

if (misses.length > 0) {
	console.log('  Text-entry controls MISSING maxlength:');
	for (const x of misses.slice(0, 40)) {
		console.log(`    ${x.file}:${x.line}  <${x.tag} type=${x.type}>`);
	}
	if (misses.length > 40) console.log(`    ... and ${misses.length - 40} more`);
	console.log('');
}
console.log(
	`  scanned ${filesScanned} .svelte files, ${textEntryFields} text-entry controls`
);
if (failures.length > 0) {
	console.log(failures.join('\n'));
	console.log('');
}

console.log('────────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} text-input-maxlength-coverage scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}
