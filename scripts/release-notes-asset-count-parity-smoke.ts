#!/usr/bin/env tsx
/**
 * scripts/release-notes-asset-count-parity-smoke.ts
 *
 * Structural Defense #36 — release-notes asset-count parity
 * (cp84 Lesson #4 #1, shipped cp85).
 *
 * Catches the cp84-A1 drift class: RELEASE-NOTES-*.md carries
 * literal asset-count claims ("Sixteen tradable assets",
 * "thirteen are trade-only", "Three can pay listing fees") that
 * silently go stale as new assets are added to the registry.
 *
 * The cp84 manual fix touched 5 sections to bring counts back
 * in line.  Without this smoke, the next asset addition would
 * leak the same drift.
 *
 * Source of truth:
 *
 *   - Total tradable count: `ASSET_TICKERS.length` in
 *     `packages/asset-registry/src/index.ts`.
 *   - Fee-eligible count: count of `canPayListingFee: true` in
 *     `packages/asset-registry/src/index.ts`.
 *   - Trade-only count: total - fee-eligible.
 *
 * Pattern set (English release notes only — translated FAQ
 * entries are out of scope; they'd need per-locale count-word
 * maps, deferred to a future smoke if drift surfaces in
 * translations).
 *
 *   1. "<N> tradable assets"               → matches ASSET_TICKERS.length
 *   2. "<N> ... trade-only"                → matches trade-only count
 *   3. "<N> ... (can pay )?listing fees"   → matches fee-eligible count
 *
 * Each pattern is matched in the RELEASE-NOTES-*.md file(s)
 * found under repo root.  Each match's count-word is compared
 * to the truth-source.
 *
 * Each (file, pattern, match) tuple = one scenario.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

console.log('\n── release-notes asset-count parity smoke ──────────────\n');

// ─── 1. Resolve truth-source counts from the registry ─────────────
const REGISTRY_PATH = join(REPO, 'packages/asset-registry/src/index.ts');
const registryText = readFileSync(REGISTRY_PATH, 'utf8');

// ASSET_TICKERS array literal — parse the bracketed list.
// Regex matches the export line; the count is the number of
// quoted strings inside.
const tickersMatch = registryText.match(
	/export\s+const\s+ASSET_TICKERS\s*=\s*\[([^\]]+)\]/
);
if (!tickersMatch) {
	console.log('  ✗ could not locate ASSET_TICKERS in registry');
	console.log('\n✗ 1/1 scenarios failed');
	process.exit(1);
}
const tickerStrings = tickersMatch[1]!.match(/'[A-Z0-9]+'/g) ?? [];
// cp425 — these release-notes counts describe the tradable *cryptocurrencies*
// ("N tradable assets", "N trade-only", "N can pay listing fees"). Goods assets
// (barter) are a distinct category with their own release-notes section, not one
// of the coins, so they must NOT count here. Derive the goods tickers straight
// from the isGoodsAsset predicate body and exclude them.
const goodsMatch = registryText.match(
	/export\s+function\s+isGoodsAsset[^{]*\{([^}]+)\}/
);
const goodsTickers = new Set(goodsMatch ? (goodsMatch[1]!.match(/'[A-Z0-9]+'/g) ?? []) : []);
const cryptoTickers = tickerStrings.filter((t) => !goodsTickers.has(t));
const tradableCount = cryptoTickers.length;

// canPayListingFee: true count.
const feeEligibleMatches = registryText.match(/canPayListingFee:\s*true/g) ?? [];
const feeEligibleCount = feeEligibleMatches.length;

const tradeOnlyCount = tradableCount - feeEligibleCount;

console.log(`  truth-source counts (from packages/asset-registry/src/index.ts):`);
console.log(`    tradable   = ${tradableCount}`);
console.log(`    fee-eligible (canPayListingFee=true) = ${feeEligibleCount}`);
console.log(`    trade-only = ${tradeOnlyCount}`);

// ─── 2. Count-word ↔ number map ──────────────────────────────────
const WORDS_TO_NUMBERS: Record<string, number> = {
	one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
	eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
	thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
	seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20
};

// Reverse map (1 → "one") so error messages can suggest the
// correct word.
const NUMBERS_TO_WORDS: Record<number, string> = {};
for (const [w, n] of Object.entries(WORDS_TO_NUMBERS)) {
	NUMBERS_TO_WORDS[n] = w;
}

function parseCount(token: string): number | null {
	const lower = token.toLowerCase();
	if (lower in WORDS_TO_NUMBERS) return WORDS_TO_NUMBERS[lower]!;
	const n = parseInt(lower, 10);
	return isFinite(n) && n > 0 ? n : null;
}

// ─── 3. Find release-notes files ─────────────────────────────────
const allFiles = readdirSync(REPO);
const RELEASE_NOTES_FILES = allFiles
	.filter((f) => /^RELEASE-NOTES-v[\w.-]+\.md$/.test(f))
	.map((f) => join(REPO, f));

if (RELEASE_NOTES_FILES.length === 0) {
	console.log('  ✗ no RELEASE-NOTES-v*.md files found at repo root');
	console.log('\n✗ 1/1 scenarios failed');
	process.exit(1);
}

console.log(`  release-notes files: ${RELEASE_NOTES_FILES.length}`);

// ─── 4. Patterns + truth-source mapping ─────────────────────────
interface Pattern {
	readonly name: string;
	readonly regex: RegExp;
	readonly expected: number;
}

const PATTERNS: Pattern[] = [
	{
		name: 'tradable-assets',
		// "<N> tradable assets" — N is a count word or digit
		regex: /\b([A-Za-z]+|\d+)\s+tradable\s+assets?\b/gi,
		expected: tradableCount
	},
	{
		name: 'trade-only',
		// "<N> ... trade-only" — N is at the start of the trade-only
		// claim sentence.  Match the count word that comes
		// immediately before "are trade-only" / "trade-only" so we
		// don't false-fire on the asset-list flag inside e.g.
		// "(trade-only on Morphit)".  Looking for a pattern like:
		//   "the other thirteen are trade-only"
		//   "thirteen trade-only assets"
		regex: /\b([A-Za-z]+|\d+)\s+(?:are\s+)?trade[-\s]only\b/gi,
		expected: tradeOnlyCount
	},
	{
		name: 'fee-eligible',
		// "<N> — (BTC, XMR, BLURT) — ... listing fees" — the count
		// word that precedes a "listing fee(s)" claim, allowing
		// the claim to span line breaks in markdown.
		// To avoid matching "listing fee is roughly $0.12" type
		// statements which don't include a count word in lead,
		// require count + dash/comma/word + listing fee within
		// a short window.  Period (`.`) is the only stop char —
		// we WANT to cross newlines because asset list claims in
		// release notes wrap.
		regex:
			/\b([A-Za-z]+|\d+)\s*(?:—|--|,|of\s+them|of\s+the\s+sixteen)[^.]{0,160}?listing\s+fees?\b/gi,
		expected: feeEligibleCount
	}
];

// ─── 5. Scan + verify ────────────────────────────────────────────
interface Finding {
	file: string;
	pattern: string;
	expected: number;
	actual: number;
	matchText: string;
	matchToken: string;
}

const findings: Finding[] = [];
let scenarios = 0;

for (const filePath of RELEASE_NOTES_FILES) {
	const text = readFileSync(filePath, 'utf8');
	const rel = filePath.replace(REPO + '/', '');
	for (const pat of PATTERNS) {
		pat.regex.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = pat.regex.exec(text)) !== null) {
			const token = m[1]!;
			const actual = parseCount(token);
			if (actual === null) {
				// Token isn't a number/word — likely a false positive
				// (e.g. "the trade-only assets" matched the trade-only
				// pattern with token="the").  Skip silently.
				continue;
			}
			scenarios++;
			if (actual !== pat.expected) {
				findings.push({
					file: rel,
					pattern: pat.name,
					expected: pat.expected,
					actual,
					matchText: m[0].slice(0, 80),
					matchToken: token
				});
			}
		}
	}
}

console.log(`  pattern matches checked: ${scenarios}`);

if (scenarios === 0) {
	console.log('\n  ✗ no asset-count claims found in any release-notes file —');
	console.log('    pattern set is broken, or release notes don\'t carry claims');
	console.log('    (this is itself a regression — release notes should claim asset counts)');
	console.log('\n✗ 1/1 scenarios failed');
	process.exit(1);
}

if (findings.length > 0) {
	console.log(`\n  ✗ ${findings.length} mismatched asset-count claim(s):`);
	for (const f of findings) {
		const suggested = NUMBERS_TO_WORDS[f.expected] ?? String(f.expected);
		console.log(
			`    - ${f.file} [${f.pattern}]: claims \`${f.matchToken}\` ` +
				`but registry says ${f.expected} (\`${suggested}\`)`
		);
		console.log(`        context: "${f.matchText.replace(/\s+/g, ' ').trim()}"`);
	}
	console.log(
		`\n  Fix: edit the release-notes file(s) so each count matches the` +
			`\n  registry, OR update the registry if the asset list changed and` +
			`\n  the release notes are the leading source.`
	);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${findings.length}/${scenarios} scenarios failed`);
	process.exit(1);
}

console.log(`  ✓ all ${scenarios} asset-count claims match the registry`);
console.log('\n──────────────────────────────────────────────────────');
console.log(`✓ all ${scenarios} scenarios passed`);
