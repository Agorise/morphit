#!/usr/bin/env tsx
/**
 * i18n-translator-diff.
 *
 * Human-friendly diff tool for translators.  Given a target locale,
 * compares en.json (source of truth) against locale.json and emits
 * three files into ./translator-output/:
 *
 *   1.  <locale>-missing.json5  — keys in en.json absent from locale.
 *       Each entry includes the English source as a `//` comment
 *       so the translator has context.  Output is JSON5 (not JSON)
 *       so comments survive the round-trip.
 *
 *   2.  <locale>-fallback.txt   — keys present in locale but byte-
 *       identical to the English source.  Likely placeholders the
 *       translator never reached.  Plain text, sorted, one per line.
 *
 *   3.  <locale>-extra.txt      — keys present in locale but absent
 *       from en.json.  Probably stale; should be removed.
 *
 * Usage:
 *   npx tsx apps/web/scripts/i18n-translator-diff.ts <locale>
 *   npx tsx apps/web/scripts/i18n-translator-diff.ts es
 *   npx tsx apps/web/scripts/i18n-translator-diff.ts ja        ← planned locale
 *                                                                (will create
 *                                                                 a fresh file
 *                                                                 from en.json)
 *
 * Notes:
 *   - For a PLANNED locale (no JSON file yet), this outputs every
 *     key in en.json as "missing" — i.e. the starting point for a
 *     fresh translation.
 *   - The script does NOT modify any source files.  Translators
 *     hand-merge results from translator-output/ back into
 *     apps/web/src/lib/i18n/locales/<code>.json after translating.
 *   - ALLOW_LIST entries from i18n-translation-completeness-smoke
 *     are EXCLUDED from the fallback report — those are intentionally
 *     identical across locales (brand names, command-line strings,
 *     URLs, ticker symbols).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LOCALES, PLANNED_LOCALES } from '../src/lib/i18n/locales';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const LOCALES_DIR = join(WEB_ROOT, 'src/lib/i18n/locales');
const OUTPUT_DIR = join(HERE, 'translator-output');

// ─── CLI parsing ──────────────────────────────────────────────────

const TARGET = process.argv[2];
if (!TARGET) {
	console.error('Usage: npx tsx apps/web/scripts/i18n-translator-diff.ts <locale>');
	console.error('');
	console.error(
		'Supported locales:',
		SUPPORTED_LOCALES.map((l) => l.code).join(', ')
	);
	console.error(
		'Planned locales: ',
		PLANNED_LOCALES.map((l) => l.code).join(', ')
	);
	process.exit(2);
}
if (TARGET === 'en') {
	console.error('en is the source of truth; nothing to diff.');
	process.exit(2);
}

const all = [...SUPPORTED_LOCALES, ...PLANNED_LOCALES];
const known = all.find((l) => l.code === TARGET);
if (!known) {
	console.error(`Unknown locale: ${TARGET}`);
	console.error('');
	console.error(
		'Supported locales:',
		SUPPORTED_LOCALES.map((l) => l.code).join(', ')
	);
	console.error(
		'Planned locales: ',
		PLANNED_LOCALES.map((l) => l.code).join(', ')
	);
	process.exit(2);
}

const TARGET_IS_PLANNED = PLANNED_LOCALES.some((l) => l.code === TARGET);

// ─── Load files ───────────────────────────────────────────────────

const EN_PATH = join(LOCALES_DIR, 'en.json');
const TARGET_PATH = join(LOCALES_DIR, `${TARGET}.json`);

if (!existsSync(EN_PATH)) {
	console.error(`Source-of-truth file missing: ${EN_PATH}`);
	process.exit(1);
}
const enData = JSON.parse(readFileSync(EN_PATH, 'utf8'));

let targetData: unknown = {};
if (existsSync(TARGET_PATH)) {
	targetData = JSON.parse(readFileSync(TARGET_PATH, 'utf8'));
} else if (!TARGET_IS_PLANNED) {
	console.error(
		`${TARGET} is marked SUPPORTED but its JSON file is missing: ${TARGET_PATH}`
	);
	console.error(
		'Either ship the JSON file, or move the entry back to PLANNED_LOCALES.'
	);
	process.exit(1);
}

// ─── Walk / flatten ───────────────────────────────────────────────

type Leaf = { path: string; value: string };

function flatten(obj: unknown, base = '', out: Leaf[] = []): Leaf[] {
	if (typeof obj === 'string') {
		out.push({ path: base, value: obj });
		return out;
	}
	if (obj && typeof obj === 'object') {
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			flatten(v, base ? `${base}.${k}` : k, out);
		}
	}
	return out;
}

const enLeaves = flatten(enData);
const targetLeaves = flatten(targetData);

const enMap = new Map(enLeaves.map((l) => [l.path, l.value]));
const targetMap = new Map(targetLeaves.map((l) => [l.path, l.value]));

// ─── Compute the three sets ───────────────────────────────────────

// Allow-list of paths whose English source is intentionally identical
// across locales.  Mirrors what i18n-translation-completeness-smoke uses
// — brand names, command-line strings, URLs, code identifiers.  Anything
// matching one of these prefixes is suppressed from the fallback report.
const ALLOWLIST_PREFIXES = [
	'meta.', // OG/twitter meta values
	'brand.',
	'about_this_instance.cli.', // command names
	'glossary.terms.', // technical terms often un-translated
	'release.signature.', // OpenPGP-related literals
];
const isAllowlisted = (path: string) =>
	ALLOWLIST_PREFIXES.some((p) => path.startsWith(p));

const missing: Leaf[] = [];
const fallback: Leaf[] = [];
for (const { path, value } of enLeaves) {
	const tv = targetMap.get(path);
	if (tv === undefined) {
		missing.push({ path, value });
	} else if (tv === value && !isAllowlisted(path)) {
		fallback.push({ path, value });
	}
}

const extra: string[] = [];
for (const path of targetMap.keys()) {
	if (!enMap.has(path)) extra.push(path);
}

missing.sort((a, b) => a.path.localeCompare(b.path));
fallback.sort((a, b) => a.path.localeCompare(b.path));
extra.sort();

// ─── Emit ─────────────────────────────────────────────────────────

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

function escapeJsonString(s: string): string {
	return s
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t');
}

function comment(s: string): string {
	// Wrap a long English string into a // comment block.  Keep each
	// line under ~110 chars so translators reading in narrow editors
	// don't have to scroll horizontally.
	const limit = 100;
	const words = s.split(/\s+/);
	const lines: string[] = [];
	let buf = '';
	for (const w of words) {
		if ((buf + ' ' + w).trim().length > limit) {
			lines.push(buf);
			buf = w;
		} else {
			buf = (buf + ' ' + w).trim();
		}
	}
	if (buf) lines.push(buf);
	return lines.map((l) => `  // EN: ${l}`).join('\n');
}

// ── missing.json5 ──
const missingPath = join(OUTPUT_DIR, `${TARGET}-missing.json5`);
const missingBody = [
	`// ${TARGET}-missing.json5 — keys absent from apps/web/src/lib/i18n/locales/${TARGET}.json`,
	`// Generated by i18n-translator-diff for translators of "${known.englishName}" (${TARGET})`,
	`// ${missing.length} missing keys.  Translate each value, then merge back into ${TARGET}.json.`,
	`// `,
	`// Preserve key paths exactly.  Preserve {placeholders}.  Preserve ICU {count, plural, ...} blocks.`,
	`// Strip the // comments before merging (they're only here for translator context).`,
	`{`,
	...missing.flatMap(({ path, value }, i) => {
		const trailing = i === missing.length - 1 ? '' : ',';
		return [comment(value), `  "${path}": "${escapeJsonString(value)}"${trailing}`];
	}),
	`}`,
	''
].join('\n');
writeFileSync(missingPath, missingBody);

// ── fallback.txt ──
const fallbackPath = join(OUTPUT_DIR, `${TARGET}-fallback.txt`);
const fallbackBody = [
	`# ${TARGET}-fallback.txt — keys present in ${TARGET}.json but byte-identical to en.json`,
	`# Likely awaiting translation.  ${fallback.length} entries.`,
	`# `,
	`# Some strings are *intentionally* identical across locales (brand names, CLI commands, URLs).`,
	`# Those are filtered out of this report via the ALLOWLIST_PREFIXES list at the top of`,
	`# apps/web/scripts/i18n-translator-diff.ts.  Everything left below should be reviewed.`,
	``,
	...fallback.map(({ path, value }) => `${path}\t${value.slice(0, 120)}`),
	''
].join('\n');
writeFileSync(fallbackPath, fallbackBody);

// ── extra.txt ──
const extraPath = join(OUTPUT_DIR, `${TARGET}-extra.txt`);
const extraBody = [
	`# ${TARGET}-extra.txt — keys present in ${TARGET}.json but absent from en.json`,
	`# ${extra.length} entries.  Probably stale; remove or report.`,
	``,
	...extra,
	''
].join('\n');
writeFileSync(extraPath, extraBody);

// ─── Summary ──────────────────────────────────────────────────────

console.log(
	`── i18n-translator-diff: ${known.englishName} (${TARGET}) ${
		TARGET_IS_PLANNED ? '· PLANNED locale (starting fresh)' : '· SUPPORTED locale'
	} ──`
);
console.log('');
console.log(`Source (en.json):                  ${enLeaves.length} keys`);
console.log(
	`Target (${TARGET}.json):                  ${targetLeaves.length} keys${
		TARGET_IS_PLANNED ? ' (no file yet — starting from zero)' : ''
	}`
);
console.log('');
console.log(`Missing in ${TARGET}:                  ${missing.length} keys`);
console.log(
	`Identical to EN (likely untranslated): ${fallback.length} keys (${
		isAllowlisted('')
			? '0'
			: ALLOWLIST_PREFIXES.length
	} prefixes allowlisted)`
);
console.log(`Extra (in ${TARGET}, not in en):       ${extra.length} keys`);
console.log('');
console.log(`Output:`);
console.log(`  ${missingPath}`);
console.log(`  ${fallbackPath}`);
console.log(`  ${extraPath}`);
console.log('');
console.log('Next steps for translators:');
console.log(`  1. Edit ${TARGET}-missing.json5 — translate each value`);
console.log(`  2. Merge the translated entries into ${TARGET_PATH}`);
console.log(`  3. Review ${TARGET}-fallback.txt for stale "fallback to English" entries`);
console.log(`  4. Run: npx tsx apps/web/scripts/i18n-locale-parity-smoke.ts`);
