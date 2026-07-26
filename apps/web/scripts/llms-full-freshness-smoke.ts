#!/usr/bin/env tsx
/**
 * apps/web/scripts/llms-full-freshness-smoke.ts
 *
 * Structural Defense — llms-full.txt freshness (cp229).
 *
 * `apps/web/static/llms-full.txt` is the single-file FAQ corpus that
 * AI retrieval tools ingest (llmstxt.org convention). It is a DERIVED
 * artifact: `scripts/build-llms-full.mjs` reads the English FAQ from
 * `apps/web/src/lib/i18n/locales/en.json` and emits it verbatim. The
 * web build regenerates it via the `build:llms-full` prebuild step.
 *
 * Why this smoke exists: in cp229 the committed corpus was found to
 * have drifted ~2 weeks (≈230 lines) from en.json — it still carried
 * the pre-PWA-migration app-store / F-Droid / APK / sideloading FAQ
 * entries (long since removed in the codebase), was missing the
 * `privacy_coins_onchain` entry entirely, and described RSS as a
 * single "RSS 2.0 feed" from before the 3-format (xml/atom/json)
 * rework. Nobody re-ran the generator after editing the FAQ, and no
 * guard caught it — so the AI-crawler corpus served stale answers
 * (the exact failure cp213's accuracy audit was meant to prevent).
 *
 * The media-kit zip already has a freshness guard for the same class
 * of bug (source edited, derived artifact not regenerated, stale bytes
 * ship). This is a sibling guard. (og-image.png used to have one too,
 * but as of cp567 the PNG is hand-authored, not derived, so it needs
 * no source-drift guard.)
 *
 * Robust to git checkout: it does NOT use mtime. It re-derives the
 * expected bytes from the current en.json via the generator's pure
 * `renderLlmsFull()` export and diffs them against the committed
 * file. Source and artifact must agree exactly.
 *
 * Scenarios:
 *   L-1: build-llms-full.mjs exports a callable renderLlmsFull()
 *   L-2: build-llms-full.mjs keeps a run-as-main guard
 *        (so importing it here can't clobber the artifact)
 *   L-3: apps/web/static/llms-full.txt exists (committed)
 *   L-4: committed artifact === renderLlmsFull(en.json) byte-for-byte
 *        — THE drift guard
 *   L-5: footer "Total FAQ entries: N" matches en.json faq.entries
 *   L-6: apps/web prebuild wires build:llms-full (regenerates on build)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLlmsFull } from '../../../scripts/build-llms-full.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const GENERATOR = join(REPO, 'scripts/build-llms-full.mjs');
const EN_JSON = join(REPO, 'apps/web/src/lib/i18n/locales/en.json');
const ARTIFACT = join(REPO, 'apps/web/static/llms-full.txt');
const WEB_PKG = join(REPO, 'apps/web/package.json');

let passed = 0;
let failed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

/**
 * Summarize a drift between two multi-line strings: how many lines
 * differ and which FAQ `## ` sections those lines fall under. Keeps
 * the failure message short and actionable instead of dumping the
 * full ~230-line diff.
 */
function driftSummary(expected: string, actual: string): string {
	const exp = expected.split('\n');
	const act = actual.split('\n');
	const max = Math.max(exp.length, act.length);
	const sections = new Set<string>();
	let diffLines = 0;
	let lastHeadingExp = '(preamble)';
	for (let i = 0; i < max; i++) {
		const e = exp[i] ?? '';
		const a = act[i] ?? '';
		if (e.startsWith('## ')) lastHeadingExp = e.slice(3);
		if (e !== a) {
			diffLines++;
			sections.add(lastHeadingExp);
		}
	}
	const list = [...sections].slice(0, 12);
	const more = sections.size > list.length ? ` …+${sections.size - list.length} more` : '';
	return (
		`${diffLines} line(s) differ across ${sections.size} FAQ section(s).\n` +
		`      Run 'node scripts/build-llms-full.mjs' from the repo root to regenerate.\n` +
		`      Drifted sections: ${list.join(' | ')}${more}`
	);
}

console.log('\n── llms-full-freshness smoke (cp229) ──────────────────\n');

// L-1: generator exports a callable renderLlmsFull()
if (typeof renderLlmsFull === 'function') {
	pass('build-llms-full.mjs exports a callable renderLlmsFull()');
} else {
	fail(
		'build-llms-full.mjs exports a callable renderLlmsFull()',
		`expected a function export, got ${typeof renderLlmsFull} — the generator must expose its pure renderer so this smoke can re-derive expected bytes`
	);
}

// L-2: run-as-main guard present (importing the generator above must
// not have written to the artifact — verified structurally so a
// future refactor can't silently reintroduce an import-time write).
if (existsSync(GENERATOR)) {
	const src = readFileSync(GENERATOR, 'utf8');
	const hasGuard = /process\.argv\[1\]/.test(src) && /import\.meta\.url|__filename/.test(src);
	if (hasGuard) {
		pass('build-llms-full.mjs keeps a run-as-main guard (import is side-effect-free)');
	} else {
		fail(
			'build-llms-full.mjs keeps a run-as-main guard',
			`no run-as-main guard found — importing the generator would write ${ARTIFACT} as a side effect of running this smoke`
		);
	}
} else {
	fail('build-llms-full.mjs keeps a run-as-main guard', `generator missing at ${GENERATOR}`);
}

// L-3: committed artifact exists
if (existsSync(ARTIFACT)) {
	pass('apps/web/static/llms-full.txt exists (committed)');
} else {
	fail(
		'apps/web/static/llms-full.txt exists (committed)',
		`missing — run 'node scripts/build-llms-full.mjs' to generate it`
	);
}

// L-4: THE drift guard — committed bytes must equal re-derived bytes
if (existsSync(EN_JSON) && existsSync(ARTIFACT) && typeof renderLlmsFull === 'function') {
	const en = JSON.parse(readFileSync(EN_JSON, 'utf8'));
	const expected = renderLlmsFull(en);
	const committed = readFileSync(ARTIFACT, 'utf8');
	if (committed === expected) {
		pass('committed llms-full.txt matches current en.json FAQ (no drift)');
	} else {
		fail(
			'committed llms-full.txt matches current en.json FAQ',
			driftSummary(expected, committed)
		);
	}
}

// L-5: footer entry count matches en.json
if (existsSync(EN_JSON) && existsSync(ARTIFACT)) {
	const en = JSON.parse(readFileSync(EN_JSON, 'utf8'));
	const want = Object.keys(en.faq?.entries ?? {}).length;
	const committed = readFileSync(ARTIFACT, 'utf8');
	const m = committed.match(/Total FAQ entries:\s*(\d+)/);
	const got = m ? Number(m[1]) : NaN;
	if (got === want) {
		pass(`footer entry count matches en.json (${want})`);
	} else {
		fail(
			'footer entry count matches en.json',
			`footer says ${Number.isNaN(got) ? '(not found)' : got}, en.json has ${want} FAQ entries — regenerate`
		);
	}
}

// L-6: prebuild wires build:llms-full
if (existsSync(WEB_PKG)) {
	const pkg = JSON.parse(readFileSync(WEB_PKG, 'utf8'));
	const prebuild = pkg.scripts?.prebuild ?? '';
	const hasScript = typeof pkg.scripts?.['build:llms-full'] === 'string';
	if (hasScript && /build:llms-full/.test(prebuild)) {
		pass('apps/web prebuild regenerates llms-full.txt (build:llms-full wired)');
	} else {
		fail(
			'apps/web prebuild regenerates llms-full.txt',
			`prebuild='${prebuild}', build:llms-full script ${hasScript ? 'present' : 'MISSING'} — the artifact must regenerate on every build or it will drift again`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nllms-full-freshness smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} llms-full-freshness checks pass`);
