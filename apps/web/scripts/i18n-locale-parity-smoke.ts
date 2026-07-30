#!/usr/bin/env tsx
/**
 * i18n-locale-parity-smoke.
 *
 * Sister smoke to i18n-key-coverage-smoke.  Where coverage
 * checks that every code-referenced key exists in en.json,
 * THIS smoke checks that every key in en.json also exists
 * (with the same nested shape) in every other locale.
 *
 * The existing voucher-locale-parity-smoke is scoped to a
 * specific set of voucher-flow keys.  This smoke is repo-
 * wide.
 *
 * Failure modes caught:
 *   1. Translator adds a new key to en.json but forgets to
 *      add it to fr.json — fa users see the english fallback,
 *      OR if svelte-i18n is configured to NOT fall back, see
 *      the raw key string.
 *   2. Translator removes a key from one locale "to clean
 *      up" — the translation is now broken for that locale.
 *   3. Two locales drift apart silently.
 *
 * Coverage:
 *   1. EN is the source of truth — every key in EN must
 *      appear in every other locale.
 *   2. No locale has keys that aren't in EN (those would be
 *      dead translations no code references).
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/i18n-locale-parity-smoke.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const LOC_DIR = join(REPO, 'src/lib/i18n/locales');

function flattenKeys(d: unknown, prefix = ''): Set<string> {
	const out = new Set<string>();
	if (typeof d !== 'object' || d === null) return out;
	for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
		const kp = prefix ? `${prefix}.${k}` : k;
		if (typeof v === 'string') {
			out.add(kp);
		} else {
			for (const child of flattenKeys(v, kp)) out.add(child);
		}
	}
	return out;
}

function main(): void {
	console.log('i18n-locale-parity smoke:\n');

	const localeFiles = readdirSync(LOC_DIR)
		.filter((f) => f.endsWith('.json'))
		.sort();
	if (localeFiles.length < 2) {
		console.log('  ✗ expected at least 2 locales, found', localeFiles.length);
		process.exit(1);
	}

	const enPath = join(LOC_DIR, 'en.json');
	const enKeys = flattenKeys(JSON.parse(readFileSync(enPath, 'utf8')));

	let failures = 0;
	let scenarios = 0;

	scenarios++;
	console.log(`  ✓ EN locale loaded with ${enKeys.size} flat keys`);

	for (const lf of localeFiles) {
		if (lf === 'en.json') continue;
		const loc = lf.slice(0, -5);
		const path = join(LOC_DIR, lf);
		const keys = flattenKeys(JSON.parse(readFileSync(path, 'utf8')));

		// Scenario per locale: every EN key must be in this
		// locale, and no extras.
		scenarios++;
		const missing: string[] = [];
		for (const k of enKeys) if (!keys.has(k)) missing.push(k);
		const extra: string[] = [];
		for (const k of keys) if (!enKeys.has(k)) extra.push(k);

		if (missing.length === 0 && extra.length === 0) {
			console.log(`  ✓ ${loc}: ${keys.size} keys, parity with EN`);
		} else {
			console.log(`  ✗ ${loc}: parity broken`);
			if (missing.length > 0) {
				console.log(`      missing-vs-EN (${missing.length}):`);
				for (const m of missing.slice(0, 10)) console.log(`        ${m}`);
				if (missing.length > 10) console.log(`        … and ${missing.length - 10} more`);
			}
			if (extra.length > 0) {
				console.log(`      extra-vs-EN (${extra.length}):`);
				for (const e of extra.slice(0, 10)) console.log(`        ${e}`);
				if (extra.length > 10) console.log(`        … and ${extra.length - 10} more`);
			}
			failures++;
		}
	}

	console.log(
		`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} scenarios passed`
	);
	process.exit(failures === 0 ? 0 : 1);
}

main();
