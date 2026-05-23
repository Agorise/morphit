#!/usr/bin/env tsx
/**
 * apps/web/scripts/carrier-registry-invariants-smoke.ts
 *
 * Structural Defense (cp120) — invariants over the bundled
 * shipping-carrier registry at `apps/web/src/lib/shipping/carriers.ts`.
 *
 * Scenarios:
 *   C-1: 20 canonical carriers + 1 'other' = 21 entries total
 *   C-2: every key is lowercase alphanumeric + underscore, 2-32 chars
 *   C-3: every name is non-empty, ≤80 chars
 *   C-4: every region is non-empty, ≤60 chars
 *   C-5: every canonical carrier has an https:// tracking URL template
 *        containing literal `{tracking}` placeholder
 *   C-6: 'other' has trackingUrlTemplate === null (sender supplies)
 *   C-7: no duplicate keys
 *   C-8: alphabetical order within array (keys, except 'other' last)
 *   C-9: buildTrackingUrl produces a valid URL when substituted
 *   C-10: locale coverage — each Morphit locale has at least one
 *         region-relevant carrier in the bundled set
 */

import { CARRIERS, getCarrier, buildTrackingUrl } from '../src/lib/shipping/carriers';

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── carrier-registry-invariants smoke (cp120) ─────\n');

// C-1: total count
const otherCount = CARRIERS.filter((c) => c.key === 'other').length;
const canonicalCount = CARRIERS.length - otherCount;
if (CARRIERS.length === 21 && canonicalCount === 20 && otherCount === 1) {
	pass(
		`C-1 registry has 20 canonical + 1 'other' = 21 total (got ${CARRIERS.length} = ${canonicalCount} canonical + ${otherCount} other)`
	);
} else {
	fail(
		'C-1 registry has 20 canonical + 1 other',
		`got ${CARRIERS.length} total = ${canonicalCount} canonical + ${otherCount} other`
	);
}

// C-2: key shape
const KEY_RE = /^[a-z0-9_]{2,32}$/;
const badKeys = CARRIERS.filter((c) => !KEY_RE.test(c.key));
if (badKeys.length === 0) {
	pass('C-2 every key is lowercase alphanumeric+underscore, 2-32 chars');
} else {
	fail(
		'C-2 every key matches /^[a-z0-9_]{2,32}$/',
		`${badKeys.length} bad: ${badKeys.map((c) => c.key).join(', ')}`
	);
}

// C-3: name non-empty, bounded
const badNames = CARRIERS.filter((c) => !c.name || c.name.length > 80);
if (badNames.length === 0) {
	pass('C-3 every name is non-empty, ≤80 chars');
} else {
	fail(
		'C-3 every name is non-empty ≤80 chars',
		`${badNames.length} bad: ${badNames.map((c) => c.key).join(', ')}`
	);
}

// C-4: region non-empty, bounded
const badRegions = CARRIERS.filter((c) => !c.region || c.region.length > 60);
if (badRegions.length === 0) {
	pass('C-4 every region is non-empty, ≤60 chars');
} else {
	fail(
		'C-4 every region is non-empty ≤60 chars',
		`${badRegions.length} bad: ${badRegions.map((c) => c.key).join(', ')}`
	);
}

// C-5: canonical carriers have valid tracking URL template
const URL_TEMPLATE_RE = /^https:\/\//;
const badTemplates = CARRIERS.filter(
	(c) =>
		c.key !== 'other' &&
		(!c.trackingUrlTemplate ||
			!URL_TEMPLATE_RE.test(c.trackingUrlTemplate) ||
			!c.trackingUrlTemplate.includes('{tracking}'))
);
if (badTemplates.length === 0) {
	pass('C-5 every canonical carrier has https:// tracking URL with {tracking} placeholder');
} else {
	fail(
		'C-5 canonical carriers have valid https:// + {tracking} templates',
		`${badTemplates.length} bad: ${badTemplates.map((c) => `${c.key}: ${c.trackingUrlTemplate}`).join('; ')}`
	);
}

// C-6: 'other' template is null
const other = CARRIERS.find((c) => c.key === 'other');
if (other && other.trackingUrlTemplate === null) {
	pass(`C-6 'other' carrier has null trackingUrlTemplate`);
} else {
	fail(
		`C-6 'other' carrier has null trackingUrlTemplate`,
		`'other' was: ${JSON.stringify(other)}`
	);
}

// C-7: no duplicate keys
const seenKeys = new Set<string>();
const duplicates: string[] = [];
for (const c of CARRIERS) {
	if (seenKeys.has(c.key)) duplicates.push(c.key);
	seenKeys.add(c.key);
}
if (duplicates.length === 0) {
	pass(`C-7 no duplicate carrier keys (${seenKeys.size} unique)`);
} else {
	fail('C-7 no duplicate carrier keys', `duplicates: ${duplicates.join(', ')}`);
}

// C-8: alphabetical order (except 'other' at end)
const canonical = CARRIERS.filter((c) => c.key !== 'other');
const sorted = [...canonical].map((c) => c.key).sort();
const actual = canonical.map((c) => c.key);
const orderMismatch = actual.findIndex((k, i) => k !== sorted[i]);
const otherIsLast = CARRIERS[CARRIERS.length - 1].key === 'other';
if (orderMismatch === -1 && otherIsLast) {
	pass(`C-8 canonical carriers in alphabetical order; 'other' at end`);
} else {
	fail(
		`C-8 canonical carriers alphabetical; 'other' last`,
		`mismatch at index ${orderMismatch} (expected ${sorted[orderMismatch]}, got ${actual[orderMismatch]}); otherLast=${otherIsLast}`
	);
}

// C-9: buildTrackingUrl produces valid URL
const probe = buildTrackingUrl('https://example.com/track?id={tracking}', 'ABC123');
if (probe === 'https://example.com/track?id=ABC123') {
	pass('C-9 buildTrackingUrl substitutes {tracking} with URL-encoded value');
} else {
	fail('C-9 buildTrackingUrl works', `got: ${probe}`);
}
// Also check encoding of special chars
const probe2 = buildTrackingUrl('https://example.com/track?id={tracking}', 'AB CD-EF/GH');
if (probe2 === 'https://example.com/track?id=AB%20CD-EF%2FGH') {
	pass('C-9b buildTrackingUrl URL-encodes special chars (space → %20, / → %2F)');
} else {
	fail('C-9b buildTrackingUrl URL-encodes special chars', `got: ${probe2}`);
}

// C-10: locale coverage
// Each Morphit locale should have at least one region-relevant
// canonical carrier (excluding global-only options).
const LOCALE_REGION_HINTS: Record<string, RegExp> = {
	en: /United States|United Kingdom|Australia|Canada|India/i,
	es: /Spain/i,
	de: /Germany/i,
	pl: /Poland/i,
	fr: /France/i,
	it: /Italy/i,
	ru: /Russia/i,
	fa: /Iran/i,
	'zh-CN': /China/i,
	'zh-HK': /Hong Kong|China/i
};
const missingLocaleCoverage: string[] = [];
for (const [loc, regionRe] of Object.entries(LOCALE_REGION_HINTS)) {
	const hits = CARRIERS.filter((c) => regionRe.test(c.region));
	if (hits.length === 0) missingLocaleCoverage.push(loc);
}
if (missingLocaleCoverage.length === 0) {
	pass(`C-10 every Morphit locale has at least one region-relevant carrier`);
} else {
	fail(
		'C-10 every Morphit locale has at least one region-relevant carrier',
		`missing: ${missingLocaleCoverage.join(', ')}`
	);
}

// getCarrier lookups
const checkKeys = ['usps', 'ups', 'fedex', 'dhl_express', 'china_post_ems', 'other'];
const missingLookup = checkKeys.filter((k) => !getCarrier(k));
if (missingLookup.length === 0) {
	pass(`C-11 getCarrier() returns entries for known keys (${checkKeys.length} checked)`);
} else {
	fail(`C-11 getCarrier() returns entries for known keys`, `missing: ${missingLookup.join(', ')}`);
}
const ghostLookup = getCarrier('nonexistent_carrier_xyz');
if (ghostLookup === undefined) {
	pass(`C-12 getCarrier() returns undefined for unknown keys`);
} else {
	fail(`C-12 getCarrier() returns undefined for unknown keys`, `got: ${JSON.stringify(ghostLookup)}`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error(`\ncarrier-registry-invariants smoke FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} carrier-registry-invariants scenarios passed`);
