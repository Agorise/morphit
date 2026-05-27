#!/usr/bin/env tsx
/**
 * locale-source-of-truth-smoke.
 *
 * Enforces that the canonical SUPPORTED_LOCALES array in
 * `apps/web/src/lib/i18n/locales.ts` is the single source of truth
 * for "which locales does Morphit ship."
 *
 * BACKGROUND.  As of cp141, every smoke and script that needs the
 * supported-locale set either:
 *   (a) imports SUPPORTED_LOCALES from $lib/i18n/locales, or
 *   (b) reads the on-disk JSON files in apps/web/src/lib/i18n/locales/
 *       (the i18n-locale-registry-smoke enforces 1:1 correspondence
 *       between the TS array and the JSON files).
 *
 * Before cp141 there were ~12 files with inline locale arrays like:
 *     const LOCALES = ['en', 'es', 'de', 'pl', 'fr', 'it', 'ru',
 *                      'fa', 'zh-CN', 'zh-HK'];
 * which would silently under-cover any newly-graduated 11th locale.
 *
 * INVARIANT.  No file in apps/web/scripts/, scripts/, or apps/web/src/
 * may declare an inline array of locale codes that exactly mirrors
 * the current SUPPORTED_LOCALES set (or a permutation of it).
 *
 * ALLOWED.  Intentional SUBSETS for documented backlog-tracking are
 * fine and tracked here:
 *
 *   - BACKLOG_LOCALES   (long/short-form en-fallback-floor smokes)
 *   - NATIVE_LOCALES    (per-asset / what-is-asset native-locale-floor)
 *
 * The smoke flags any file that has all 10 codes inline but isn't on
 * the allowlist of structural exceptions below.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

// The current SUPPORTED set as a sorted array for permutation-check.
const SUPPORTED_SORTED = SUPPORTED_LOCALES.map((l) => l.code).sort();

// Files whose locale array is THE source of truth itself — these
// must NOT be flagged.
const SOURCE_OF_TRUTH_FILES = new Set([
	'apps/web/src/lib/i18n/locales.ts'
]);

// Files that intentionally hard-code a SUBSET (not the full set).
// These are allowed because they track specific backlog or native-
// translation status that's narrower than "all supported."
const ALLOWED_SUBSET_FILES = new Set([
	'apps/web/scripts/long-form-en-fallback-floor-smoke.ts',
	'apps/web/scripts/short-form-en-fallback-floor-smoke.ts',
	'apps/web/scripts/per-asset-key-family-native-locale-floor-smoke.ts',
	'apps/web/scripts/what-is-asset-faq-native-locale-floor-smoke.ts',
	'apps/web/scripts/native-translations-snapshot-rebuild.ts'
]);

// Files that hard-code the FULL set inline because they CAN'T import
// SUPPORTED_LOCALES — runtime constraints (no module loader) or
// cross-workspace boundaries.  Each entry below is paired with a
// rationale; the smoke verifies the inline list MATCHES the canonical
// set so drift becomes a CI failure rather than a silent miss.
const PAIRED_UPDATE_FILES: Record<string, string> = {
	// app.html runs in the document <head> before the JS bundle loads,
	// so it can't `import` SUPPORTED_LOCALES.  Drift is prevented by
	// this smoke checking the inlined array equals the canonical set.
	'apps/web/src/app.html':
		'Runs in the document <head> before the JS bundle; cannot import.',
	// pushLocalize lives in the indexer workspace which doesn't import
	// from apps/web/.  The KNOWN_LOCALES array AND the IndexerPushLocale
	// type union both need to stay in sync — paired-update enforced here.
	'apps/indexer/src/indexer/pushLocalize.ts':
		'Indexer workspace; cannot import from apps/web. Type union + array both must mirror SUPPORTED_LOCALES.'
};

// Roots to walk.
const SCAN_ROOTS = [
	'apps/web/scripts',
	'apps/web/src',
	'apps/indexer/scripts',
	'apps/indexer/src',
	'apps/relay/scripts',
	'apps/relay/src',
	'apps/mcp-server/scripts',
	'apps/mcp-server/src',
	'scripts'
];

const SKIP_DIRS = new Set([
	'node_modules',
	'.svelte-kit',
	'dist',
	'build',
	'.git',
	'translator-output',
	'.test-output',
	'test-output'
]);

const SKIP_EXT_RE = /\.(d\.ts|d\.mts|d\.cts|json|svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf)$/;

function* walk(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			yield* walk(full);
		} else if (st.isFile() && !SKIP_EXT_RE.test(entry)) {
			yield full;
		}
	}
}

// ─── Detection ────────────────────────────────────────────────────

// Find every literal-string array in the file.  We look for the
// pattern `[ 'code1', 'code2', ... ]` (or with double-quotes) and
// parse out the contents.
const ARRAY_RE = /\[\s*((?:['"][a-zA-Z][a-zA-Z0-9-]*['"]\s*,?\s*){2,})\]/g;
const TOKEN_RE = /['"]([a-zA-Z][a-zA-Z0-9-]*)['"]/g;

function findFullSetArrays(src: string): Array<{ snippet: string; codes: string[] }> {
	const hits: Array<{ snippet: string; codes: string[] }> = [];
	let m: RegExpExecArray | null;
	ARRAY_RE.lastIndex = 0;
	while ((m = ARRAY_RE.exec(src)) !== null) {
		const inner = m[1]!;
		const codes: string[] = [];
		let t: RegExpExecArray | null;
		TOKEN_RE.lastIndex = 0;
		while ((t = TOKEN_RE.exec(inner)) !== null) {
			codes.push(t[1]!);
		}
		// We only care about arrays that match the supported set
		// exactly (as a set).  Same length AND same codes.
		if (codes.length !== SUPPORTED_SORTED.length) continue;
		const sortedCodes = [...codes].sort();
		const sameSet = sortedCodes.every((c, i) => c === SUPPORTED_SORTED[i]);
		if (!sameSet) continue;
		hits.push({ snippet: m[0]!.slice(0, 120), codes });
	}
	return hits;
}

// ─── Walk and check ───────────────────────────────────────────────

const violations: Array<{ file: string; line: number; snippet: string }> = [];
const pairedSeen = new Set<string>();

for (const root of SCAN_ROOTS) {
	const abs = join(REPO_ROOT, root);
	for (const file of walk(abs)) {
		const rel = relative(REPO_ROOT, file).replace(/\\/g, '/');
		if (SOURCE_OF_TRUTH_FILES.has(rel)) continue;
		if (ALLOWED_SUBSET_FILES.has(rel)) continue;
		let src: string;
		try {
			src = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		const hits = findFullSetArrays(src);
		if (hits.length === 0) continue;
		// Paired-update files: hits are EXPECTED but verified to match.
		if (rel in PAIRED_UPDATE_FILES) {
			pairedSeen.add(rel);
			continue;
		}
		// Anyone else with full-set inline arrays: violation.
		for (const hit of hits) {
			const idx = src.indexOf(hit.snippet);
			const line = idx >= 0 ? src.slice(0, idx).split('\n').length : 1;
			violations.push({ file: rel, line, snippet: hit.snippet });
		}
	}
}

// Paired-update sanity: every entry in PAIRED_UPDATE_FILES must have
// been seen.  If one is missing, either the file was deleted, the array
// was removed, OR the array drifted from the canonical set (in which
// case findFullSetArrays didn't match it, which IS the drift we want
// to catch).
const pairedMissing: string[] = [];
for (const pf of Object.keys(PAIRED_UPDATE_FILES)) {
	if (!pairedSeen.has(pf)) pairedMissing.push(pf);
}

// ─── Report ───────────────────────────────────────────────────────

console.log('── locale-source-of-truth smoke ─────────────────────');
console.log('');
console.log(
	`Canonical SUPPORTED_LOCALES (${SUPPORTED_SORTED.length}): ${SUPPORTED_SORTED.join(', ')}`
);
console.log('');

if (violations.length === 0 && pairedMissing.length === 0) {
	console.log(
		'  ✓ no file outside the source-of-truth allowlist hardcodes the full SUPPORTED_LOCALES set'
	);
	console.log(
		`  ✓ ${pairedSeen.size}/${Object.keys(PAIRED_UPDATE_FILES).length} paired-update files inline the canonical set correctly`
	);
	for (const f of pairedSeen) {
		console.log(`      • ${f}`);
	}
	console.log('');
	console.log('2 passed, 0 failed (2 total)');
	console.log('✓ locale-source-of-truth smoke holds');
	process.exit(0);
}

let failed = 0;

if (violations.length > 0) {
	failed++;
	console.log(`  ✗ ${violations.length} hardcoded inline locale array(s) found:`);
	console.log('');
	for (const v of violations) {
		console.log(`    - ${v.file}:${v.line}`);
		console.log(`        ${v.snippet}…`);
	}
	console.log('');
	console.log(
		'Fix: import SUPPORTED_LOCALES from $lib/i18n/locales (or relative path)'
	);
	console.log('     and derive your local LOCALES array from it, e.g.:');
	console.log('       const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);');
	console.log('');
	console.log(
		'If this is an INTENTIONAL subset, add the file path to ALLOWED_SUBSET_FILES'
	);
	console.log(
		'in apps/web/scripts/locale-source-of-truth-smoke.ts.'
	);
	console.log(
		'If this file cannot import (runtime constraint), add it to PAIRED_UPDATE_FILES'
	);
	console.log('with a rationale comment.');
}

if (pairedMissing.length > 0) {
	failed++;
	console.log('');
	console.log(
		`  ✗ ${pairedMissing.length} paired-update file(s) no longer mirror SUPPORTED_LOCALES:`
	);
	for (const pm of pairedMissing) {
		console.log(`    - ${pm}`);
		console.log(`        Rationale: ${PAIRED_UPDATE_FILES[pm]}`);
	}
	console.log('');
	console.log(
		'These files inline the canonical locale set because they cannot import it.'
	);
	console.log(
		'When SUPPORTED_LOCALES changes, the inline array in each of these files MUST be updated'
	);
	console.log('in the same commit.  This smoke is the paired-update enforcement.');
}

console.log('');
console.log(`${2 - failed} passed, ${failed} failed (2 total)`);
process.exit(1);
