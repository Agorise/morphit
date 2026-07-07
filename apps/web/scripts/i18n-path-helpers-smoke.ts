#!/usr/bin/env tsx
/**
 * i18n-path-helpers-smoke.
 *
 * Unit-style smoke for the per-locale prerendering helpers shipped
 * in `src/lib/i18n/path.ts`.  These are pure functions intended to
 * be verifiable WITHOUT a working SvelteKit build (per the Part
 * 121 cp6 plow-through that scoped item 2 to helpers + REVISIT
 * rather than full route restructure).
 *
 * Coverage:
 *   - localePath: bare paths, idempotency, re-prefixing, query +
 *     fragment preservation, invalid lang fallback, non-absolute
 *     input passthrough, root-path edge case.
 *   - stripLocalePrefix: prefixed and bare inputs, root + query
 *     preservation, unsupported prefix passthrough.
 *   - pickLocaleFromAcceptLanguages: ordered priority, zh script
 *     variant mapping (zh-TW → zh-HK, zh-Hans-CN → zh-CN),
 *     language-family match (de-AT → de), empty prefs fallback,
 *     no-match fallback, non-string defensive filter.
 *   - isLocalePrefixed: positive + negative cases.
 *
 * Why exhaustive on these particular cases: each one corresponds
 * to a real call site in the design doc's implementation sketch
 * (idempotency = defensive link wrapping; re-prefixing = language
 * switcher; query/fragment = share-this-page URLs; zh script
 * variant = real navigator.languages contents seen on Hong Kong
 * Safari).
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/i18n-path-helpers-smoke.ts
 */

import {
	localePath,
	stripLocalePrefix,
	pickLocaleFromAcceptLanguages,
	isLocalePrefixed
} from '../src/lib/i18n/path';

interface Scenario {
	readonly name: string;
	readonly run: () => void;
}

function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}
function eq<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
	}
}

const SCENARIOS: readonly Scenario[] = [
	// ─── localePath ─────────────────────────────────────────────
	{
		name: 'localePath wraps a bare path with the given locale',
		run: () => {
			eq(localePath('/orderbook', 'es'), '/es/orderbook', 'localePath');
			eq(localePath('/faq', 'de'), '/de/faq', 'localePath');
			eq(localePath('/run-a-node', 'fa'), '/fa/run-a-node', 'localePath');
		}
	},
	{
		name: 'localePath maps root path to /<lang>',
		run: () => {
			eq(localePath('/', 'es'), '/es', 'root es');
			eq(localePath('/', 'zh-HK'), '/zh-HK', 'root zh-HK');
		}
	},
	{
		name: 'localePath defaults to en when lang omitted',
		run: () => {
			eq(localePath('/faq'), '/en/faq', 'default lang');
			eq(localePath('/'), '/en', 'default root');
		}
	},
	{
		name: 'localePath falls back to default on unsupported lang',
		run: () => {
			eq(localePath('/faq', 'xx' as never), '/en/faq', 'unsupported');
			eq(localePath('/faq', '' as never), '/en/faq', 'empty');
		}
	},
	{
		name: 'localePath is idempotent for already-prefixed paths',
		run: () => {
			eq(localePath('/es/orderbook', 'es'), '/es/orderbook', 'idempotent es');
			eq(localePath('/zh-HK/faq', 'zh-HK'), '/zh-HK/faq', 'idempotent zh-HK');
			eq(localePath('/de', 'de'), '/de', 'idempotent root');
		}
	},
	{
		name: 'localePath re-prefixes to a different locale (language switcher case)',
		run: () => {
			eq(localePath('/es/orderbook', 'fa'), '/fa/orderbook', 'es→fa');
			eq(localePath('/zh-HK/post', 'en'), '/en/post', 'zh-HK→en');
			// Trailing slash on the locale root is normalized away —
			// `/en/` → `/pl` (canonical no-trailing-slash form).  Bare
			// `/en` also goes to `/pl`.  Non-root paths preserve their
			// trailing slash (see "preserves trailing slashes" scenario).
			eq(localePath('/en/', 'pl'), '/pl', 'en root → pl root (normalized)');
		}
	},
	{
		name: 'localePath preserves query strings',
		run: () => {
			eq(localePath('/orderbook?asset=BTC', 'es'), '/es/orderbook?asset=BTC', 'query');
			eq(localePath('/faq?q=fees&category=trading', 'de'), '/de/faq?q=fees&category=trading', 'multi-query');
		}
	},
	{
		name: 'localePath preserves fragments',
		run: () => {
			eq(localePath('/faq#fees', 'pl'), '/pl/faq#fees', 'fragment');
			eq(localePath('/orderbook?asset=XMR#row-3', 'fr'), '/fr/orderbook?asset=XMR#row-3', 'query+fragment');
		}
	},
	{
		name: 'localePath preserves trailing slashes',
		run: () => {
			eq(localePath('/orderbook/', 'it'), '/it/orderbook/', 'trailing slash');
		}
	},
	{
		name: 'localePath passes through non-absolute input unchanged',
		run: () => {
			eq(localePath('orderbook', 'es'), 'orderbook', 'no-slash');
			eq(localePath('?lang=es'), '?lang=es', 'query-only');
			eq(localePath('#fragment'), '#fragment', 'fragment-only');
			eq(localePath(''), '', 'empty');
		}
	},

	// ─── stripLocalePrefix ──────────────────────────────────────
	{
		name: 'stripLocalePrefix removes a known prefix',
		run: () => {
			eq(stripLocalePrefix('/es/orderbook'), '/orderbook', 'es');
			eq(stripLocalePrefix('/zh-HK/faq'), '/faq', 'zh-HK');
			eq(stripLocalePrefix('/de'), '/', 'root');
			eq(stripLocalePrefix('/fa/'), '/', 'root with trailing slash');
		}
	},
	{
		name: 'stripLocalePrefix leaves bare paths alone',
		run: () => {
			eq(stripLocalePrefix('/orderbook'), '/orderbook', 'bare');
			eq(stripLocalePrefix('/faq'), '/faq', 'bare faq');
			eq(stripLocalePrefix('/'), '/', 'bare root');
		}
	},
	{
		name: 'stripLocalePrefix preserves query + fragment',
		run: () => {
			eq(stripLocalePrefix('/es/orderbook?asset=BTC'), '/orderbook?asset=BTC', 'query');
			eq(stripLocalePrefix('/de/faq#fees'), '/faq#fees', 'fragment');
			eq(stripLocalePrefix('/fa/post?id=1#top'), '/post?id=1#top', 'both');
		}
	},
	{
		name: 'stripLocalePrefix ignores unsupported first-segments',
		run: () => {
			eq(stripLocalePrefix('/xx/orderbook'), '/xx/orderbook', 'unsupported xx');
			eq(stripLocalePrefix('/orderbook/en'), '/orderbook/en', 'en is mid-path, not prefix');
		}
	},

	// ─── pickLocaleFromAcceptLanguages ──────────────────────────
	{
		name: 'pickLocale honors ordered preference',
		run: () => {
			eq(pickLocaleFromAcceptLanguages(['pl', 'en-US', 'en']), 'pl', 'pl first');
			eq(pickLocaleFromAcceptLanguages(['en-US', 'pl']), 'en', 'en first');
		}
	},
	{
		name: 'pickLocale maps zh-TW to zh-HK (Traditional)',
		run: () => {
			eq(pickLocaleFromAcceptLanguages(['zh-TW']), 'zh-HK', 'zh-TW');
			eq(pickLocaleFromAcceptLanguages(['zh-HK']), 'zh-HK', 'zh-HK exact');
			eq(pickLocaleFromAcceptLanguages(['zh-MO']), 'zh-HK', 'zh-MO');
		}
	},
	{
		name: 'pickLocale maps zh-Hans variants to zh-CN (Simplified)',
		run: () => {
			eq(pickLocaleFromAcceptLanguages(['zh-Hans-CN']), 'zh-CN', 'zh-Hans-CN');
			eq(pickLocaleFromAcceptLanguages(['zh-CN']), 'zh-CN', 'zh-CN exact');
			eq(pickLocaleFromAcceptLanguages(['zh-SG']), 'zh-CN', 'zh-SG');
			eq(pickLocaleFromAcceptLanguages(['zh']), 'zh-CN', 'bare zh');
		}
	},
	{
		name: 'pickLocale falls back to language family for non-Chinese',
		run: () => {
			eq(pickLocaleFromAcceptLanguages(['de-AT']), 'de', 'de-AT → de');
			eq(pickLocaleFromAcceptLanguages(['es-MX']), 'es', 'es-MX → es');
			eq(pickLocaleFromAcceptLanguages(['fa-IR']), 'fa', 'fa-IR → fa');
			eq(pickLocaleFromAcceptLanguages(['en-GB']), 'en', 'en-GB → en');
		}
	},
	{
		name: 'pickLocale returns default when nothing matches',
		run: () => {
			eq(pickLocaleFromAcceptLanguages(['ko', 'ja', 'vi']), 'en', 'no match');
			eq(pickLocaleFromAcceptLanguages([]), 'en', 'empty list');
		}
	},
	{
		name: 'pickLocale tolerates malformed entries',
		run: () => {
			eq(pickLocaleFromAcceptLanguages(['', 'es']), 'es', 'empty first');
			// Defensive — types say string[] but real-world callers
			// may pass through navigator data that contains nulls.
			eq(pickLocaleFromAcceptLanguages([null as unknown as string, undefined as unknown as string, 'de']), 'de', 'null/undefined skipped');
		}
	},

	// ─── isLocalePrefixed ───────────────────────────────────────
	{
		name: 'isLocalePrefixed detects known prefixes',
		run: () => {
			assert(isLocalePrefixed('/es/orderbook'), 'es prefix');
			assert(isLocalePrefixed('/zh-HK/faq'), 'zh-HK prefix');
			assert(isLocalePrefixed('/fa/'), 'fa root');
			assert(isLocalePrefixed('/de'), 'de bare');
		}
	},
	{
		name: 'isLocalePrefixed returns false for bare or non-locale paths',
		run: () => {
			assert(!isLocalePrefixed('/orderbook'), 'bare path');
			assert(!isLocalePrefixed('/xx/orderbook'), 'unsupported xx');
			assert(!isLocalePrefixed('/'), 'root');
			assert(!isLocalePrefixed(''), 'empty');
			assert(!isLocalePrefixed('orderbook'), 'no-slash');
		}
	}
];

let failed = 0;
let passed = 0;

console.log('i18n-path-helpers smoke:\n');

for (const sc of SCENARIOS) {
	try {
		sc.run();
		console.log(`  ✓ ${sc.name}`);
		passed++;
	} catch (err) {
		console.error(`  ✗ ${sc.name}`);
		console.error(`      ${err instanceof Error ? err.message : String(err)}`);
		failed++;
	}
}

console.log('');
if (failed === 0) {
	console.log(`✓ all ${passed} i18n-path-helpers scenarios passed`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} failed, ${passed} passed`);
	process.exit(1);
}
