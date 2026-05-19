#!/usr/bin/env tsx
/**
 * chat-asset-ticker-narrow-union-parity-smoke (Part 122 cp34).
 *
 * Mechanically enforces the cp33 LL #38 lesson: every hand-written
 * narrow union of ChatAssetTicker values (`'btc' | 'xmr' | 'usdt'
 * | ...` in source files) MUST contain every value from the
 * canonical union.  Cp33's CODE-6 was a cluster of 4 such sites
 * that fell out of sync when DAI and USDC were added (narrow
 * unions don't auto-extend when the canonical union does).
 *
 * Scope: .ts and .svelte files under apps/web/src/lib and
 * apps/web/src/routes; excludes test files and the canonical
 * source file itself (apps/web/src/lib/chat/payload.ts).
 *
 * Detection: any string literal pattern of the form
 *   'btc'<spaces>|<spaces>'xmr'<spaces>|<spaces>...
 * (single-quoted lowercase identifiers separated by `|`).  When
 * found, every canonical ChatAssetTicker value must appear in the
 * union — or the union must be specifically allow-listed in
 * NARROW_BY_DESIGN below (e.g. fee_method which is BLURT/BTC/XMR
 * only by Memory #23, or the listing-fee panel which is BTC/XMR
 * only).
 *
 * Run: `node --experimental-strip-types
 *       apps/web/scripts/chat-asset-ticker-narrow-union-parity-smoke.ts`
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

// Canonical source of truth — must match ChatAssetTicker in payload.ts.
const CANONICAL = new Set([
	'btc', 'xmr', 'blurt', 'usdt', 'usdc', 'dai', 'bch', 'ltc', 'dash', 'doge', 'zec', 'arrr', 'dcr', 'sol', 'eth', 'xrp'
]);

// Unions allow-listed as INTENTIONALLY narrow.  Each entry is a
// substring of the matched line; if any of these substrings is
// present in the line, the union is allow-listed.
const NARROW_BY_DESIGN: Array<{ pattern: string; reason: string }> = [
	{
		pattern: "'blurt' | 'waived_first_buy' | 'btc' | 'xmr'",
		reason: 'fee_method — Memory #23 invariant (listing fees BLURT/BTC/XMR only)'
	},
	{
		pattern: "'blurt' | 'btc' | 'xmr' | 'waived_first_buy'",
		reason: 'fee_method reordered — Memory #23 invariant'
	},
	{
		pattern: "method: 'btc' | 'xmr';",
		reason: 'ListingFeeAddressPanel — fee-paying methods only (BTC + XMR)'
	},
	{
		pattern: "'btc' | 'xmr' | 'bch' | 'ltc' | 'dash' | 'doge' | 'zec' | 'arrr' | 'dcr' | 'sol' | 'eth' | 'xrp'",
		reason: 'urls.ts instanceTplKey — single-network explorer template targets only'
	},
	{
		pattern: "'btc' | 'xmr' | 'usdt' | 'usdc' | 'dai' | 'bch' | 'ltc' | 'dash' | 'doge' | 'zec' | 'arrr' | 'dcr' | 'sol' | 'eth' | 'xrp'",
		reason: 'onMarkSent / chat-funds-sent — non-BLURT external-send methods (BLURT routes through PayBlurtModal, not chat-mark-sent)'
	}
];

const SCAN_DIRS = [
	join(REPO_ROOT, 'apps/web/src/lib'),
	join(REPO_ROOT, 'apps/web/src/routes')
];

// Files to skip: tests, smokes, and the canonical source itself.
function shouldSkipFile(path: string): boolean {
	if (path.includes('/test/')) return true;
	if (path.endsWith('.test.ts') || path.endsWith('.test.svelte')) return true;
	if (path.endsWith('chat/payload.ts')) return true; // canonical source
	return false;
}

function* walk(dir: string): Generator<string> {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules') continue;
			yield* walk(p);
		} else if (ent.isFile() && (p.endsWith('.ts') || p.endsWith('.svelte'))) {
			yield p;
		}
	}
}

// Match strings of the form 'btc' | 'xmr' | 'something'
// (>=2 quoted lowercase tokens separated by |).
const UNION_RE = /'([a-z_]+)'\s*\|\s*(?:'([a-z_]+)'\s*\|?\s*)+/g;

// Skip lines that are comments (jsdoc, line comments, block
// comments).  Comments often document unions for human reference
// without being actual TypeScript narrow unions.
function isCommentLine(line: string): boolean {
	const t = line.trim();
	return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

interface Finding {
	file: string;
	line: number;
	union: string;
	missing: string[];
}

const findings: Finding[] = [];
let totalUnionsScanned = 0;

for (const dir of SCAN_DIRS) {
	for (const file of walk(dir)) {
		if (shouldSkipFile(file)) continue;
		const src = readFileSync(file, 'utf-8');
		const lines = src.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (isCommentLine(line)) continue;
			// Is the WHOLE LINE allow-listed by an intentional-narrow pattern?
			if (NARROW_BY_DESIGN.some(d => line.includes(d.pattern))) continue;
			const matches = line.match(UNION_RE);
			if (!matches) continue;
			for (const m of matches) {
				// Extract all single-quoted tokens
				const tokens = [...m.matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
				if (tokens.length < 2) continue;
				// Is the union mentioning AT LEAST 2 canonical assets?
				// (filters out unions of network names like 'erc20' | 'trc20')
				const canonicalTokens = tokens.filter(t => CANONICAL.has(t));
				if (canonicalTokens.length < 2) continue;
				totalUnionsScanned++;
				// Every canonical asset must appear
				const missing = [...CANONICAL].filter(c => !tokens.includes(c));
				if (missing.length > 0) {
					findings.push({
						file: file.replace(REPO_ROOT + '/', ''),
						line: i + 1,
						union: m.trim().slice(0, 120),
						missing
					});
				}
			}
		}
	}
}

console.log('\n── chat-asset-ticker-narrow-union-parity smoke ──────────\n');
console.log(`Scanned ${totalUnionsScanned} candidate narrow unions across`);
console.log(`${SCAN_DIRS.length} directories.\n`);

if (findings.length === 0) {
	console.log('  ✓ all narrow unions cover the full canonical 16-asset set');
	console.log('  ✓ or are documented in NARROW_BY_DESIGN allow-list');
	console.log(`\n✓ chat-asset-ticker-narrow-union-parity smoke PASSED`);
	process.exit(0);
}

console.log('🚨 FOUND drifted narrow unions:\n');
for (const f of findings) {
	console.log(`  ${f.file}:${f.line}`);
	console.log(`    union: ${f.union}`);
	console.log(`    missing: ${f.missing.join(', ')}`);
	console.log();
}

console.log(`\n✗ chat-asset-ticker-narrow-union-parity smoke FAILED`);
console.log(`  ${findings.length} narrow unions drifted from canonical`);
console.log(`  This is the cp33 CODE-6 class (LL #38).  Either widen the`);
console.log(`  union to cover all 10 canonical assets, or document the`);
console.log(`  intentional narrowness in NARROW_BY_DESIGN above.\n`);
process.exit(1);
