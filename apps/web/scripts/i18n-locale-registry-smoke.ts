#!/usr/bin/env tsx
/**
 * i18n-locale-registry-smoke.
 *
 * Validates the shape and consistency of the locale registry
 * declared in `apps/web/src/lib/i18n/index.ts`:
 *
 *   1. SUPPORTED_LOCALES and PLANNED_LOCALES are disjoint —
 *      a language can't be both shipped and planned.
 *   2. Every entry has the required fields with sensible values.
 *   3. Every SUPPORTED locale has a corresponding `<code>.json`
 *      file under `apps/web/src/lib/i18n/locales/`.
 *   4. Every JSON file in `apps/web/src/lib/i18n/locales/`
 *      corresponds to a SUPPORTED locale (no orphaned files).
 *   5. PLANNED locales do NOT have JSON files (if they did,
 *      they should graduate to SUPPORTED).
 *   6. No duplicate codes within either array.
 *   7. The 'en' locale is in SUPPORTED (it's the source of truth).
 *
 * Failure modes caught:
 *   - Locale graduates from PLANNED → SUPPORTED but the entry
 *     wasn't removed from PLANNED.
 *   - JSON file added but registry not updated (orphan file).
 *   - Registry entry added but JSON file missing (broken
 *     loader at runtime).
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/i18n-locale-registry-smoke.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const LOC_DIR = join(REPO, 'src/lib/i18n/locales');
// As of Part 121 cp6, SUPPORTED_LOCALES + PLANNED_LOCALES SSoT
// moved from i18n/index.ts to i18n/locales.ts (decoupled from
// SvelteKit's $app/environment so the pure constants can be
// imported by smokes and the prerender-redirect shell).  The
// registry-smoke regex parses the locales.ts source directly.
const INDEX_FILE = join(REPO, 'src/lib/i18n/locales.ts');

console.log('\n── i18n-locale-registry-smoke ──────────────────────────\n');

const failures: string[] = [];

function fail(msg: string): void {
	failures.push(msg);
}

// Parse the SUPPORTED_LOCALES and PLANNED_LOCALES arrays out of
// index.ts.  A regex-based parse is robust here because the
// arrays are formatted with one entry per line by convention.
const indexSrc = readFileSync(INDEX_FILE, 'utf8');

function extractLocales(arrayName: string): {
	codes: string[];
	rtlByCode: Record<string, boolean>;
	nativeByCode: Record<string, string>;
	englishByCode: Record<string, string>;
} {
	const startMarker = `export const ${arrayName} = [`;
	const start = indexSrc.indexOf(startMarker);
	if (start < 0) {
		throw new Error(
			`could not find '${startMarker}' in i18n/index.ts — has the array been renamed?`
		);
	}
	const end = indexSrc.indexOf('] as const;', start);
	if (end < 0) {
		throw new Error(`could not find closing '] as const;' for ${arrayName}`);
	}
	const block = indexSrc.slice(start, end);
	const codes: string[] = [];
	const rtlByCode: Record<string, boolean> = {};
	const nativeByCode: Record<string, string> = {};
	const englishByCode: Record<string, string> = {};
	const re =
		/\{\s*code:\s*'([^']+)',\s*nativeName:\s*'([^']+)',\s*englishName:\s*'([^']+)',\s*rtl:\s*(true|false)\s*\}/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(block)) !== null) {
		const [, code, nativeName, englishName, rtl] = m;
		codes.push(code!);
		rtlByCode[code!] = rtl === 'true';
		nativeByCode[code!] = nativeName!;
		englishByCode[code!] = englishName!;
	}
	return { codes, rtlByCode, nativeByCode, englishByCode };
}

const supported = extractLocales('SUPPORTED_LOCALES');
const planned = extractLocales('PLANNED_LOCALES');

console.log(
	`  parsed ${supported.codes.length} SUPPORTED, ${planned.codes.length} PLANNED locales`
);

// Sanity guard: the parser is regex-based and requires
// single-quoted string values.  If someone reformats the array
// to use double quotes, the regex would find zero matches and
// every disjoint/JSON-presence check would trivially pass
// against an empty list — silent failure.  Floor the SUPPORTED
// count at 1 (en is always there) so a parser miss surfaces
// as a smoke failure, not a green CI run that doesn't actually
// verify anything.
if (supported.codes.length === 0) {
	fail(
		`SUPPORTED_LOCALES parser returned 0 entries — has the array ` +
			`been reformatted (e.g. double-quoted strings, multi-line ` +
			`entries)?  The extractLocales regex needs to be updated.`
	);
}

// ── 1. Disjoint ──────────────────────────────────────────────────
for (const code of supported.codes) {
	if (planned.codes.includes(code)) {
		fail(`'${code}' is in both SUPPORTED_LOCALES and PLANNED_LOCALES — pick one`);
	}
}

// ── 2. No duplicates within either ───────────────────────────────
{
	const seen = new Set<string>();
	for (const code of supported.codes) {
		if (seen.has(code)) {
			fail(`duplicate code '${code}' in SUPPORTED_LOCALES`);
		}
		seen.add(code);
	}
}
{
	const seen = new Set<string>();
	for (const code of planned.codes) {
		if (seen.has(code)) {
			fail(`duplicate code '${code}' in PLANNED_LOCALES`);
		}
		seen.add(code);
	}
}

// ── 3. en must be in SUPPORTED ───────────────────────────────────
if (!supported.codes.includes('en')) {
	fail("'en' must be in SUPPORTED_LOCALES (it's the source-of-truth)");
}

// ── 4. Every SUPPORTED has a JSON file ───────────────────────────
const jsonFiles = readdirSync(LOC_DIR)
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.replace(/\.json$/, ''));

for (const code of supported.codes) {
	if (!jsonFiles.includes(code)) {
		fail(`SUPPORTED locale '${code}' is missing src/lib/i18n/locales/${code}.json`);
	}
}

// ── 5. Every JSON file corresponds to a SUPPORTED locale ─────────
for (const file of jsonFiles) {
	if (!supported.codes.includes(file)) {
		fail(
			`orphaned locale file src/lib/i18n/locales/${file}.json — ` +
				`add to SUPPORTED_LOCALES or remove the file`
		);
	}
}

// ── 6. PLANNED locales must NOT have JSON files ──────────────────
for (const code of planned.codes) {
	if (jsonFiles.includes(code)) {
		fail(
			`PLANNED locale '${code}' has src/lib/i18n/locales/${code}.json — ` +
				`graduate it to SUPPORTED_LOCALES`
		);
	}
}

// ── 7. nativeName / englishName not empty ────────────────────────
for (const arr of [supported, planned]) {
	for (const code of arr.codes) {
		if (arr.nativeByCode[code]!.length === 0) {
			fail(`locale '${code}' has empty nativeName`);
		}
		if (arr.englishByCode[code]!.length === 0) {
			fail(`locale '${code}' has empty englishName`);
		}
	}
}

// ── Result ───────────────────────────────────────────────────────
if (failures.length > 0) {
	console.log(`\n  ✗ ${failures.length} assertion(s) failed:`);
	for (const f of failures) console.log(`    - ${f}`);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${failures.length}/${failures.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(
		`  ✓ ${supported.codes.length} SUPPORTED + ${planned.codes.length} PLANNED, all consistent`
	);
	console.log('\n──────────────────────────────────────────────────────');
	console.log('✓ all 1 scenarios passed');
}
