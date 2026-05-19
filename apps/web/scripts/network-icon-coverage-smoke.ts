/**
 * network-icon-coverage-smoke.ts
 *
 * Pre-launch invariant: every non-'mainnet' value declared in any
 * `supportedNetworks` array in `packages/asset-registry/src/index.ts`
 * must have a matching icon SVG at
 *   apps/web/static/icons/networks/icon-network-{slug}.svg
 *
 * WHY THIS SMOKE EXISTS (Part 122 cp32 deep-deep J-2 finding):
 *
 * Until cp32 there was no automated check that the network slugs the
 * code enumerates have corresponding artwork on disk.  A future asset
 * addition (e.g. a 'moonbeam' or 'fantom' network) could ship without
 * the icon and the gap wouldn't surface until production users hit a
 * broken-image 404.
 *
 * The smoke is intentionally LIGHT: it walks the registry source as
 * text (no transpile, no runtime) and `fs.existsSync()`s each
 * expected file.  Adding a new network is then a 2-step ratchet:
 *
 *   1. Edit packages/asset-registry/src/index.ts supportedNetworks
 *   2. Run smokes — this smoke fails until the icon SVG is added
 *
 * BACK-COMPAT NOTE — Part 122 cp32:
 *
 * The smoke also captures the *post-cp32 byte budget* per icon.
 * Cp32 shipped Ken-supplied artwork that totals 6,046 bytes across
 * all 7 multi-network icons.  Memory's Priority #4 — TINY FOOTPRINT
 * — requires that future swaps not bloat this beyond a clear ceiling.
 * Per-icon ceiling: 4,096 bytes (every current icon is well under).
 * Total-budget ceiling: 16,384 bytes (currently using 36% of it).
 *
 * If a future icon swap exceeds these, the smoke fails with a clear
 * "consider re-minifying — Priority #4" diagnostic.
 *
 * Self-test on tamper: rm one icon → smoke MUST fail before tarball.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const REGISTRY_PATH = resolve(
	REPO_ROOT,
	'packages/asset-registry/src/index.ts'
);
const ICONS_DIR = resolve(
	REPO_ROOT,
	'apps/web/static/icons/networks'
);

const PER_ICON_BYTE_CEILING = 4_096;
const TOTAL_NETWORK_ICONS_BUDGET = 16_384;

// CP33 — Part 122: per-asset icon ceiling raised from 4 KB to
// 64 KB to accommodate Ken-supplied detailed artwork (DOGE icon
// is a full-color Shiba Inu illustration at ~54 KB, the
// canonical Dogecoin brand mark).  Network icons keep the
// tighter 4 KB ceiling — they're simple chain logos and don't
// need detailed illustration.  Total asset-icon budget raised
// to 128 KB (up from 32 KB) accordingly.
//
// The HEAVY MITIGATION for Priority #4 is lazy-loading, not the
// absolute byte ceiling — the ceiling is a defensive guard
// against accidental bloat (developer pastes a base64 PNG and
// renames it `.svg`).  Lazy-loading ensures the 54 KB DOGE
// icon only transfers when a viewer actually scrolls to a page
// that renders DOGE.  Home page (BTC/XMR/BLURT, ~5.6 KB
// combined) is unaffected.
const PER_ASSET_ICON_CEILING = 65_536;
const TOTAL_ASSET_ICONS_BUDGET = 131_072;

interface Scenario {
	name: string;
	run: () => string | null; // null = pass, message = fail
}

const scenarios: Scenario[] = [];

scenarios.push({
	name: 'registry source readable',
	run: () => {
		if (!existsSync(REGISTRY_PATH)) {
			return `registry not found at ${REGISTRY_PATH}`;
		}
		const src = readFileSync(REGISTRY_PATH, 'utf8');
		if (src.length < 1000) return 'registry suspiciously small';
		return null;
	}
});

// Extract every non-'mainnet' value from every supportedNetworks: [...] block
const registrySrc = readFileSync(REGISTRY_PATH, 'utf8');
const networkSet = new Set<string>();
for (const match of registrySrc.matchAll(
	/supportedNetworks:\s*\[([^\]]*)\]/g
)) {
	for (const item of match[1].split(',')) {
		const v = item.trim().replace(/^['"]|['"]$/g, '');
		if (v && v !== 'mainnet') networkSet.add(v);
	}
}

scenarios.push({
	name: 'at least one multi-network slug discovered (sanity)',
	run: () =>
		networkSet.size >= 1
			? null
			: 'expected at least one non-mainnet network slug in registry — none found, smoke regex may be broken'
});

scenarios.push({
	name: 'expected 7 multi-network slugs as of cp32 (USDT/USDC/DAI)',
	run: () =>
		networkSet.size === 7
			? null
			: `expected 7 networks at cp32, found ${networkSet.size}: ${[...networkSet].sort().join(',')} — registry may have added/removed; verify and update this assertion`
});

// Per-icon presence + byte ceiling
for (const slug of [...networkSet].sort()) {
	const iconPath = resolve(ICONS_DIR, `icon-network-${slug}.svg`);
	scenarios.push({
		name: `icon for network '${slug}' exists on disk`,
		run: () => (existsSync(iconPath) ? null : `MISSING: ${iconPath}`)
	});
	scenarios.push({
		name: `icon for '${slug}' under ${PER_ICON_BYTE_CEILING} bytes`,
		run: () => {
			if (!existsSync(iconPath)) return null; // covered by previous
			const sz = statSync(iconPath).size;
			if (sz > PER_ICON_BYTE_CEILING) {
				return `${slug}: ${sz}B > ${PER_ICON_BYTE_CEILING}B ceiling — Priority #4 says minify or replace`;
			}
			return null;
		}
	});
}

// CP32 EXTENSION — also pin every per-asset icon at /icons/icon-<ticker>.svg.
// Per-icon ceiling: 64 KB (asset icons may carry detailed brand
// artwork — Shibu Inu DOGE etc).  Total budget for 10 asset icons
// at present + headroom = 128 KB.
const ASSET_ICONS_DIR = resolve(REPO_ROOT, 'apps/web/static/icons');
const PER_ASSET_ICON_BUDGET = TOTAL_ASSET_ICONS_BUDGET;

const tickerMatch = registrySrc.match(/ASSET_TICKERS\s*=\s*\[([^\]]+)\]/);
const tickerSet = new Set<string>();
if (tickerMatch) {
	for (const m of tickerMatch[1].matchAll(/'([A-Z]+)'/g)) {
		tickerSet.add(m[1]!);
	}
}

scenarios.push({
	name: 'ASSET_TICKERS extracted from registry source',
	run: () =>
		tickerSet.size >= 10
			? null
			: `expected ≥10 tradable assets at cp33, found ${tickerSet.size}: ${[...tickerSet].sort().join(',')}`
});

for (const ticker of [...tickerSet].sort()) {
	const iconPath = resolve(
		ASSET_ICONS_DIR,
		`icon-${ticker.toLowerCase()}.svg`
	);
	scenarios.push({
		name: `asset icon for '${ticker}' exists on disk`,
		run: () => (existsSync(iconPath) ? null : `MISSING: ${iconPath}`)
	});
	scenarios.push({
		name: `asset icon for '${ticker}' under ${PER_ASSET_ICON_CEILING} bytes`,
		run: () => {
			if (!existsSync(iconPath)) return null;
			const sz = statSync(iconPath).size;
			if (sz > PER_ASSET_ICON_CEILING) {
				return `${ticker}: ${sz}B > ${PER_ASSET_ICON_CEILING}B — Priority #4`;
			}
			return null;
		}
	});
}

scenarios.push({
	name: `all asset icons combined under ${PER_ASSET_ICON_BUDGET}B (Priority #4)`,
	run: () => {
		let total = 0;
		for (const ticker of tickerSet) {
			const iconPath = resolve(
				ASSET_ICONS_DIR,
				`icon-${ticker.toLowerCase()}.svg`
			);
			if (existsSync(iconPath)) total += statSync(iconPath).size;
		}
		if (total > PER_ASSET_ICON_BUDGET) {
			return `total ${total}B > ${PER_ASSET_ICON_BUDGET}B budget — Priority #4 says re-minify`;
		}
		return null;
	}
});

scenarios.push({
	name: `all multi-network icons together under ${TOTAL_NETWORK_ICONS_BUDGET}B (Priority #4)`,
	run: () => {
		let total = 0;
		for (const slug of networkSet) {
			const iconPath = resolve(ICONS_DIR, `icon-network-${slug}.svg`);
			if (existsSync(iconPath)) total += statSync(iconPath).size;
		}
		if (total > TOTAL_NETWORK_ICONS_BUDGET) {
			return `total ${total}B > ${TOTAL_NETWORK_ICONS_BUDGET}B budget — Priority #4 says re-minify or split into separate per-asset bundles`;
		}
		return null;
	}
});

scenarios.push({
	name: 'every network icon SVG contains <title> for accessibility',
	run: () => {
		const missing: string[] = [];
		for (const slug of networkSet) {
			const iconPath = resolve(ICONS_DIR, `icon-network-${slug}.svg`);
			if (!existsSync(iconPath)) continue;
			const body = readFileSync(iconPath, 'utf8');
			if (!body.includes('<title>')) missing.push(slug);
		}
		if (missing.length > 0) {
			return `missing <title> for accessibility parity: ${missing.join(', ')}`;
		}
		return null;
	}
});

scenarios.push({
	name: 'every network icon SVG contains aria-label for screen-readers',
	run: () => {
		const missing: string[] = [];
		for (const slug of networkSet) {
			const iconPath = resolve(ICONS_DIR, `icon-network-${slug}.svg`);
			if (!existsSync(iconPath)) continue;
			const body = readFileSync(iconPath, 'utf8');
			if (!body.includes('aria-label=')) missing.push(slug);
		}
		if (missing.length > 0) {
			return `missing aria-label for accessibility parity: ${missing.join(', ')}`;
		}
		return null;
	}
});

let failed = 0;
for (const s of scenarios) {
	const err = s.run();
	if (err) {
		console.error(`  ✗ ${s.name}: ${err}`);
		failed++;
	}
}

if (failed > 0) {
	console.error(`\n  ${failed}/${scenarios.length} scenarios FAILED`);
	process.exit(1);
}
console.log(`  ✓ all ${scenarios.length} scenarios passed`);
