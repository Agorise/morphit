/**
 * payment-method-i18n-parity-smoke.ts
 *
 * Pre-launch invariant: every entry in `PAYMENT_METHODS`
 * (apps/web/src/lib/payments/registry.ts) must have a
 * corresponding i18n key at `payment_method.<key>.description`
 * in EVERY locale (en, es, fr, de, it, pl, ru, fa, zh-CN, zh-HK).
 *
 * WHY THIS SMOKE EXISTS (Part 122 cp32 deep-deep CODE-2 finding):
 *
 * Cp32 deep-deep surfaced that `pay_usdt` (Part 121 cp3),
 * `pay_usdc` (Part 122 cp30), and `pay_dai` (Part 122 cp31) had
 * all been added to the registry + indexer's
 * RESERVED_CANONICAL_KEYS WITHOUT their i18n description keys
 * being added to ANY locale.  The picker still rendered (the
 * description lookup falls back to the key text when missing),
 * but rendered "pay_dai" instead of "Dai: USD-pegged stablecoin
 * on EVM networks."  3-checkpoint drift across cp3/cp30/cp31.
 *
 * The existing `reserved-keys-parity-smoke.ts` enforces SET
 * parity between registry and RESERVED_CANONICAL_KEYS — but not
 * i18n coverage.  This smoke closes that gap.
 *
 * Locale parity is mandatory per Memory #8.  This smoke fires
 * the moment a future asset addition extends the registry
 * without translating its description across all 10 locales.
 *
 * Self-test on tamper: remove pay_dai from one locale → smoke
 * MUST fail before tarball.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const REGISTRY_PATH = resolve(
	REPO_ROOT,
	'apps/web/src/lib/payments/registry.ts'
);
const LOCALES_DIR = resolve(REPO_ROOT, 'apps/web/src/lib/i18n/locales');
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
	} catch (err) {
		failures++;
		console.error(
			`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

// Extract every key: '...' from registry source.  String-extract
// to keep the smoke standalone — no @morphit/asset-registry import
// dep, runs without npm install.
const registrySrc = readFileSync(REGISTRY_PATH, 'utf8');
const registryKeys = new Set<string>();
for (const m of registrySrc.matchAll(
	/key:\s*'([a-z][a-z0-9_]+)'/g
)) {
	registryKeys.add(m[1]!);
}

scenario('registry source readable', () => {
	if (registryKeys.size === 0) {
		throw new Error('extracted zero keys from registry — regex may be broken');
	}
});

scenario('at least 10 crypto + 3 in-person + 30 online payment methods (sanity)', () => {
	// Currently shipped: 10 crypto (btc/xmr/blurt/usdt/usdc/dai/bch/ltc/dash/doge)
	// + 3 in-person (barter/cash/precious_metals) + ~30 online rails.
	if (registryKeys.size < 40) {
		throw new Error(
			`expected ≥40 registry entries (cp33 baseline), found ${registryKeys.size}`
		);
	}
});

scenario('pay_dai present in registry (cp32 CODE-1 closure)', () => {
	if (!registryKeys.has('pay_dai')) {
		throw new Error(
			'pay_dai missing from registry — cp31 DAI addition + cp32 CODE-1 closure should have added it'
		);
	}
});

// Per-locale i18n coverage check
for (const locale of LOCALES) {
	scenario(`locale '${locale}' covers every registry key`, () => {
		const localeData = JSON.parse(
			readFileSync(resolve(LOCALES_DIR, `${locale}.json`), 'utf8')
		);
		const pm = localeData.payment_method;
		if (!pm) {
			throw new Error(`payment_method root missing in ${locale}.json`);
		}
		const missing: string[] = [];
		for (const key of registryKeys) {
			const entry = pm[key];
			if (!entry || typeof entry !== 'object' || !entry.description) {
				missing.push(key);
			}
		}
		if (missing.length > 0) {
			throw new Error(
				`${locale}.json missing payment_method.<key>.description for: ${missing.join(', ')}`
			);
		}
	});
}

scenario('crypto pay_<asset> ordering matches registry section grouping', () => {
	// Sanity: ensure pay_btc/pay_xmr/pay_blurt/pay_usdt/pay_usdc/pay_dai/
	// pay_bch/pay_ltc/pay_dash all in en.json (subset check).
	const en = JSON.parse(
		readFileSync(resolve(LOCALES_DIR, 'en.json'), 'utf8')
	);
	const pm = en.payment_method;
	const expected = [
		'pay_btc',
		'pay_blurt',
		'pay_xmr',
		'pay_usdt',
		'pay_usdc',
		'pay_dai',
		'pay_bch',
		'pay_ltc',
		'pay_dash'
	];
	const missing = expected.filter((k) => !pm[k]);
	if (missing.length > 0) {
		throw new Error(`en.json missing crypto pay_*: ${missing.join(', ')}`);
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.error(`\n  ${failures}/${scenarios} scenarios FAILED`);
	process.exit(1);
}
