#!/usr/bin/env tsx
/**
 * coin-carousel-invariants-smoke.ts
 *
 * Verifies that CoinCarousel.svelte preserves its 6 load-bearing
 * invariants:
 *
 *   I-1  Registry-driven — the visible coins are computed by
 *        filtering ASSETS from the canonical registry, NOT by
 *        a hardcoded ticker list.  Adding a new asset to the
 *        registry should automatically light it up in the
 *        carousel; removing one should remove it.  Hardcoding
 *        defeats the rationale.
 *
 *   I-2  Operator-disabled filter — the carousel checks
 *        $instance.disabled_assets and skips any ticker listed
 *        there.  Memory rule: never show a coin the operator
 *        explicitly turned off.
 *
 *   I-3  Dedupe by icon-file basename — if two registry entries
 *        share an icon file (e.g. ETH used as both an asset
 *        and a network indicator), only one carousel slot
 *        renders.  Memory rule: don't display the same icon
 *        twice in the same carousel.
 *
 *   I-4  Lazy-loaded images — every <img> in the carousel has
 *        loading="lazy" + decoding="async".  Below-the-fold
 *        rule (priority #4 tiny footprint).
 *
 *   I-5  IntersectionObserver lazy-mount — the component
 *        defers rendering the actual marquee track until the
 *        carousel scrolls within ~200px of the viewport.  A
 *        first-time visitor who never scrolls past the hero
 *        pays zero bytes for the track.
 *
 *   I-6  prefers-reduced-motion honored — the CSS marquee
 *        animation is disabled (transform paused) under the
 *        reduced-motion media query.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const COMPONENT = resolve(REPO, 'apps/web/src/lib/components/CoinCarousel.svelte');
const STATIC_ROOT = resolve(REPO, 'apps/web/static');

const src = readFileSync(COMPONENT, 'utf8');

interface Scenario {
	name: string;
	test: () => string | null;
}

const scenarios: Scenario[] = [
	{
		name: 'I-1: visible-slot set is derived from the ASSETS registry',
		test: () => {
			if (!src.includes("import { ASSETS } from '$lib/assets/registry'")) {
				return 'ASSETS not imported from the canonical registry path';
			}
			if (!/visibleSlots[\s\S]{0,200}?\$derived\.by/.test(src)) {
				return 'visibleSlots not declared as a $derived.by reactive computation';
			}
			if (!/for\s*\(\s*const\s+a\s+of\s+ASSETS\s*\)/.test(src)) {
				return 'visibleSlots computation does not iterate ASSETS';
			}
			return null;
		}
	},
	{
		name: 'I-2: operator-disabled assets are excluded',
		test: () => {
			if (!src.includes('disabled_assets')) {
				return 'visibleCoins computation does not reference disabled_assets';
			}
			if (!/\$instance/.test(src)) {
				return '$instance store not referenced';
			}
			// Verify the disabled-set check is actually applied as a filter.
			if (!/disabled\.has/.test(src)) {
				return 'disabled-asset Set.has check missing from filter pipeline';
			}
			return null;
		}
	},
	{
		name: 'I-3: dedupe by icon-file basename',
		test: () => {
			if (!/seenBasenames\s*=\s*new\s+Set/.test(src)) {
				return 'seenBasenames Set not constructed for dedupe';
			}
			if (!/seenBasenames\.has\(basename\)/.test(src)) {
				return 'seenBasenames.has(basename) check missing — duplicates would slip through';
			}
			if (!/logoSvgPath\.split\('\/'\)\.pop\(\)/.test(src)) {
				return 'basename extracted via wrong method — must be basename(logoSvgPath)';
			}
			return null;
		}
	},
	{
		name: 'I-4: every <img> has loading="lazy" + decoding="async"',
		test: () => {
			// Scope the search to the template (before the <style> block)
			// so we don't match CSS selectors like `.foo img { ... }`.
			const styleIdx = src.indexOf('<style>');
			const template = styleIdx === -1 ? src : src.slice(0, styleIdx);
			// Match self-closing <img …/> and <img …> forms; require at
			// least one attribute (a space after `img`) so `.foo img {`
			// in any stray CSS gets ignored.
			const imgs = template.match(/<img\s[^>]*?>/g) ?? [];
			if (imgs.length === 0) {
				return 'no <img> tags found in component template';
			}
			for (const img of imgs) {
				if (!/loading="lazy"/.test(img)) {
					return `<img> missing loading="lazy": ${img.slice(0, 80)}…`;
				}
				if (!/decoding="async"/.test(img)) {
					return `<img> missing decoding="async": ${img.slice(0, 80)}…`;
				}
			}
			return null;
		}
	},
	{
		name: 'I-5: IntersectionObserver lazy-mount is implemented',
		test: () => {
			if (!src.includes('IntersectionObserver(')) {
				return 'IntersectionObserver not instantiated';
			}
			if (!/mounted\s*=\s*\$state\(false\)/.test(src)) {
				return 'mounted reactive flag not declared (lazy-mount gate)';
			}
			if (!/mounted\s*=\s*true/.test(src)) {
				return 'mounted flag never flipped to true (lazy-mount never triggers)';
			}
			if (!/rootMargin:\s*['"][^'"]+['"]/.test(src)) {
				return 'IntersectionObserver missing rootMargin (would mount only ON-screen, too late)';
			}
			return null;
		}
	},
	{
		name: 'I-6: prefers-reduced-motion disables marquee animation',
		test: () => {
			if (!/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/.test(src)) {
				return 'no @media (prefers-reduced-motion: reduce) rule in <style>';
			}
			if (!/animation:\s*none/.test(src)) {
				return 'reduced-motion block does not set animation: none';
			}
			return null;
		}
	},
	{
		name: 'I-7: exactly 5 network slots; all icons exist on disk',
		test: () => {
			// Locate the NETWORK_SLOTS array.  Each entry has an
			// iconBasename matching `icon-network-<name>.svg`.
			const blockMatch = src.match(/NETWORK_SLOTS[\s\S]*?\]/);
			if (!blockMatch) return 'NETWORK_SLOTS array declaration not found';
			const block = blockMatch[0];
			const expected = new Set([
				'icon-network-arbitrum.svg',
				'icon-network-base.svg',
				'icon-network-bep20.svg',
				'icon-network-polygon.svg',
				'icon-network-trc20.svg'
			]);
			const found = new Set<string>();
			const re = /iconBasename:\s*'([^']+)'/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(block)) !== null) {
				found.add(m[1]!);
			}
			if (found.size !== 5) {
				return `expected exactly 5 network slots, found ${found.size}`;
			}
			for (const want of expected) {
				if (!found.has(want)) {
					return `missing required network slot: ${want}`;
				}
			}
			for (const got of found) {
				if (!expected.has(got)) {
					return `unexpected network slot: ${got}`;
				}
				const onDisk = join(STATIC_ROOT, 'icons/networks', got);
				if (!existsSync(onDisk)) {
					return `network icon referenced in carousel but missing on disk: ${onDisk}`;
				}
			}
			return null;
		}
	},
	{
		name: 'I-8: barter slot present; icon exists on disk',
		test: () => {
			if (!/iconPath:\s*'\/icons\/icon-barter\.png'/.test(src)) {
				return 'barter slot iconPath does not point at /icons/icon-barter.png';
			}
			if (!/home\.coin_carousel\.barter\.label/.test(src)) {
				return 'barter label i18n key not referenced';
			}
			if (!/home\.coin_carousel\.barter\.sr/.test(src)) {
				return 'barter screen-reader i18n key not referenced';
			}
			const onDisk = join(STATIC_ROOT, 'icons/icon-barter.png');
			if (!existsSync(onDisk)) {
				return `barter icon referenced in carousel but missing on disk: ${onDisk}`;
			}
			return null;
		}
	},
	{
		name: 'I-9: dedupe by basename spans coin + network + barter sources',
		test: () => {
			// All three source loops must consult the SAME seenBasenames
			// Set so an icon collision between sources collapses to one
			// slot.  Verify by counting `seenBasenames.has(...)` checks
			// — there must be at least 3 (one per source).
			const checks = src.match(/seenBasenames\.has\(/g) ?? [];
			if (checks.length < 3) {
				return `expected ≥3 seenBasenames.has() checks (one per source), found ${checks.length}`;
			}
			const adds = src.match(/seenBasenames\.add\(/g) ?? [];
			if (adds.length < 3) {
				return `expected ≥3 seenBasenames.add() calls (one per source), found ${adds.length}`;
			}
			return null;
		}
	}
];

console.log('\n── coin-carousel-invariants smoke (cp115) ───────────────\n');

let failed = 0;
let passed = 0;
for (const s of scenarios) {
	const err = s.test();
	if (err === null) {
		console.log(`  ✓ ${s.name}`);
		passed++;
	} else {
		console.log(`  ✗ ${s.name}`);
		console.log(`      ${err}`);
		failed++;
	}
}

console.log('');
console.log('──────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} coin-carousel-invariants scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failed}/${passed + failed} scenarios failed`);
process.exit(1);
