/**
 * native-translations-floor-smoke.ts
 *
 * Pre-launch invariant (LL #46 hardening): once a (key, locale) pair
 * has a native translation that differs from the canonical English
 * value, future commits must not REGRESS that pair back to
 * EN-byte-identical content.
 *
 * WHY THIS SMOKE EXISTS (Part 122 cp37 LL #46 closure):
 *
 * Cp36 surfaced LL #46 the hard way: while updating
 * `faq.entries.what_is_morphit.a` × 10 locales to include DAI + DOGE + ZEC + ARRR + DCR + SOL + ETH + XRP
 * in the asset enumeration, the initial pass applied the same
 * "native en/es/fr/de + EN-fallback for the other 6" strategy
 * Memory #29 documents for NEW asset i18n strings. That strategy is
 * correct for new keys — but `what_is_morphit` was old enough that
 * it/pl/ru/fa/zh-CN/zh-HK already had FULL NATIVE translations,
 * which the pass overwrote with EN-fallback. Caught in-flight by
 * running i18n-translation-completeness-smoke and noticing a +6
 * EN-byte-identical delta; restored manually.
 *
 * This smoke closes that class mechanically. The
 * `native-translations-snapshot.json` sibling file captures every
 * (key, locale) pair where the locale value diverges from English
 * at the time the snapshot was taken (cp37 baseline). For every
 * pair in the snapshot, this smoke asserts the locale's current
 * value is STILL not byte-identical to English. Any regression
 * (locale value got overwritten with the English text) fails
 * loudly with a per-pair diagnostic.
 *
 * The snapshot is the FLOOR. Going up (adding new native
 * translations) is unrestricted — just regenerate the snapshot
 * via the sibling rebuild script when those translations ship.
 * Going DOWN (regressing a native pair) is what this smoke
 * catches.
 *
 * Self-test on tamper: in any non-EN locale, replace a
 * snapshot-listed key's value with the EN text → smoke MUST fail
 * before tarball.
 *
 * Complements `i18n-translation-completeness-smoke.ts`, which
 * counts total EN-byte-identical entries across all locales
 * (chronic EN-fallback debt monitor). This smoke is the more
 * specific guard against the LL #46 class.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const LOCALES_DIR = resolve(REPO_ROOT, 'apps/web/src/lib/i18n/locales');
const SNAPSHOT_PATH = resolve(__dirname, 'native-translations-snapshot.json');

// Recursively flatten a nested object to a {dotted.key: leafValue} map.
// Matches the same shape the snapshot generator uses; keep in sync if
// either side changes.
function flatten(d: unknown, prefix = ''): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (d === null || typeof d !== 'object') return out;
	for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
		const full = prefix ? `${prefix}.${k}` : k;
		if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
			Object.assign(out, flatten(v, full));
		} else {
			out[full] = v;
		}
	}
	return out;
}

interface Snapshot {
	readonly _meta?: {
		readonly baseline_taken_at?: string;
		readonly en_total_leaves?: number;
		readonly native_pair_counts_per_locale?: Readonly<Record<string, number>>;
	};
	readonly natives: Readonly<Record<string, readonly string[]>>;
}

let snapshot: Snapshot;
try {
	snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
} catch (err) {
	console.error(`  ✗ failed to load snapshot at ${SNAPSHOT_PATH}: ${(err as Error).message}`);
	process.exit(1);
}

// Load EN once.
const enRaw = JSON.parse(readFileSync(resolve(LOCALES_DIR, 'en.json'), 'utf8'));
const enFlat = flatten(enRaw);

interface Scenario {
	readonly name: string;
	readonly run: () => string | null;
}

const scenarios: Scenario[] = [];

// One scenario per locale: every snapshot-listed key must still be
// non-EN-identical in that locale's current file. Per-locale scoping
// gives clearer failure messages than one giant scenario.
for (const locale of Object.keys(snapshot.natives)) {
	scenarios.push({
		name: `${locale}: every snapshot-listed key has a native translation (not EN-byte-identical)`,
		run: () => {
			let localeFlat: Record<string, unknown>;
			try {
				const raw = JSON.parse(
					readFileSync(resolve(LOCALES_DIR, `${locale}.json`), 'utf8')
				);
				localeFlat = flatten(raw);
			} catch (err) {
				return `failed to load ${locale}.json: ${(err as Error).message}`;
			}
			const regressed: string[] = [];
			const missing: string[] = [];
			for (const key of snapshot.natives[locale]) {
				const enVal = enFlat[key];
				const locVal = localeFlat[key];
				if (locVal === undefined) {
					missing.push(key);
					continue;
				}
				if (enVal !== undefined && locVal === enVal) {
					regressed.push(key);
				}
			}
			if (regressed.length === 0 && missing.length === 0) return null;
			const parts: string[] = [];
			if (regressed.length > 0) {
				const head = regressed.slice(0, 5).join(', ');
				const more = regressed.length > 5 ? ` (and ${regressed.length - 5} more)` : '';
				parts.push(
					`${regressed.length} key(s) regressed from native to EN-fallback: ${head}${more}`
				);
			}
			if (missing.length > 0) {
				const head = missing.slice(0, 5).join(', ');
				const more = missing.length > 5 ? ` (and ${missing.length - 5} more)` : '';
				parts.push(
					`${missing.length} key(s) removed from locale (was native at snapshot time): ${head}${more}`
				);
			}
			return parts.join('; ');
		}
	});
}

// Floor scenario: total native-pair count across all locales must
// not drop below the snapshot baseline. Catches the case where
// per-locale checks pass individually (because the regressing
// edits were all on keys NOT in the snapshot — e.g. a sneaky
// EN-overwrite on a key the snapshot considered EN-fallback at
// baseline that had since been natively translated).
scenarios.push({
	name: 'total native-pair count across all locales did not regress below snapshot baseline',
	run: () => {
		let total = 0;
		for (const locale of Object.keys(snapshot.natives)) {
			const raw = JSON.parse(
				readFileSync(resolve(LOCALES_DIR, `${locale}.json`), 'utf8')
			);
			const flat = flatten(raw);
			for (const key of Object.keys(enFlat)) {
				const locVal = flat[key];
				if (locVal !== undefined && locVal !== enFlat[key]) total++;
			}
		}
		const baseline = Object.values(snapshot.natives).reduce(
			(sum, arr) => sum + arr.length,
			0
		);
		if (total < baseline) {
			return `total native-pair count ${total} < baseline ${baseline} (regression of ${baseline - total} pairs)`;
		}
		return null;
	}
});

// Snapshot integrity: snapshot must list at least one native key
// for each non-EN locale (catches accidental snapshot regenerate
// against a corrupted tree).
scenarios.push({
	name: 'snapshot lists at least 100 native keys for every non-EN locale (integrity check)',
	run: () => {
		const sparse: string[] = [];
		for (const [locale, keys] of Object.entries(snapshot.natives)) {
			if (keys.length < 100) sparse.push(`${locale}:${keys.length}`);
		}
		if (sparse.length > 0) {
			return `snapshot appears corrupted — these locales have suspiciously few natives: ${sparse.join(', ')}`;
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
	console.error(`\n  To regenerate the snapshot (after deliberately adding new native translations):`);
	console.error(`    tsx apps/web/scripts/native-translations-snapshot-rebuild.ts`);
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally.
console.log(`✓ all ${scenarios.length} native-translations-floor scenarios passed`);
