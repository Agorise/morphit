#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/price-primary-fallback-smoke.ts (cp604)
 *
 * Pins the BLURT/USD "source of truth" precedence: Blurt's own
 * `api.blurt.blog/price_info` feed is the PRIMARY source — tried FIRST
 * and committed whenever it returns a plausible value — and the
 * CEX-aggregator average is only a FALLBACK when the feed is down or
 * implausible (then morphit_native, then the static floor).
 *
 * The runtime precedence itself is exercised by the vitest suite
 * (test/indexer/price/compositeSource.test.ts — the "primary tier"
 * block). THIS smoke is the STRUCTURAL guard: it asserts the FACTORY
 * actually wires the Blurt feed into the composite's `primaryUpstreams`
 * (NOT the averaged `upstreams`), and that the composite still runs the
 * primary tier ahead of the average — the exact regressions that would
 * silently demote the feed back to "one averaged source among many".
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function pass(msg: string): void {
	passed++;
	console.log(`  \u2713 ${msg}`);
}
function fail(id: string, msg: string): void {
	failed++;
	console.error(`  \u2717 ${id}: ${msg}`);
}

const priceDir = resolve(__dirname, '..', 'src', 'indexer', 'price');
const composite = readFileSync(resolve(priceDir, 'compositeSource.ts'), 'utf-8');
const factory = readFileSync(resolve(priceDir, 'factory.ts'), 'utf-8');

// ── compositeSource: the primary tier exists and runs first ──
if (/readonly primaryUpstreams\?:/.test(composite)) {
	pass('composite exposes an optional primaryUpstreams tier');
} else {
	fail('C-1', 'compositeSource lost the primaryUpstreams config field');
}

if (composite.includes('this.config.primaryUpstreams ?? []') && composite.includes("'refreshed_primary'")) {
	pass('composite refresh consults primaryUpstreams and commits refreshed_primary');
} else {
	fail('C-2', 'compositeSource refresh no longer runs the primary tier');
}

const primaryComment = composite.indexOf('Primary tier: an authoritative single source');
const externalComment = composite.indexOf('External tier: fetch all concurrently');
if (primaryComment !== -1 && externalComment !== -1 && primaryComment < externalComment) {
	pass('primary tier runs BEFORE the external average in refreshOnce');
} else {
	fail('C-3', 'primary tier is not ordered before the external average');
}

if (composite.includes('[...(this.config.primaryUpstreams ?? []), ...this.config.upstreams].map')) {
	pass('sourceStatus() reports the primary source alongside the aggregators');
} else {
	fail('C-4', 'sourceStatus no longer includes the primary tier');
}

// ── factory: the Blurt feed is the PRIMARY, not one averaged input ──
if (/primaryUpstreams\.push\(\{\s*name:\s*'blurt_price_feed'/.test(factory)) {
	pass("factory pushes 'blurt_price_feed' into primaryUpstreams (the source of truth)");
} else {
	fail('F-1', 'factory no longer wires blurt_price_feed as a primary source');
}

// Regression guard: it must NOT be back in the averaged upstreams pool.
if (!/\bupstreams\.push\(\{\s*name:\s*'blurt_price_feed'/.test(factory)) {
	pass('blurt_price_feed is NOT in the averaged upstreams pool');
} else {
	fail('F-2', 'blurt_price_feed is back in the averaged upstreams — no longer the source of truth');
}

if (/\n\t\tprimaryUpstreams,\n/.test(factory)) {
	pass('factory passes primaryUpstreams to CompositeCachedPriceSource');
} else {
	fail('F-3', 'factory no longer passes primaryUpstreams to the composite');
}

// ── the intent is documented (so the "why" survives) ──
if (factory.includes('api.blurt.blog/price_info') && /PRIMARY/.test(factory) && /source of truth/i.test(factory)) {
	pass('factory documents api.blurt.blog/price_info as the primary source of truth');
} else {
	fail('F-4', 'factory no longer documents the Blurt feed as the primary source of truth');
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nprice-primary-fallback-smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${total} price-primary-fallback scenarios passed`);
process.exit(0);
