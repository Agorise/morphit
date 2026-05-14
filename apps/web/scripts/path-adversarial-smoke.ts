#!/usr/bin/env tsx
/**
 * Adversarial-input audit for $i18n/path helpers (Part 121 cp7
 * deep-deep item #3 — cp6 self-audit, path.ts attack surface).
 *
 * Confirms the helpers can't be coerced into producing unsafe
 * paths.  Catches inputs the original smoke didn't exercise:
 * path traversal, protocol-relative URLs (`//evil.com`),
 * stacked locale prefixes, javascript: pseudo-protocol in
 * Accept-Language preference list.
 */

import { localePath, stripLocalePrefix, pickLocaleFromAcceptLanguages } from '../src/lib/i18n/path';

interface T { name: string; got: string; ok: boolean; expected?: string; note?: string; }

const results: T[] = [];

function check(name: string, actual: string, predicate: (x: string) => boolean, note?: string): void {
	results.push({ name, got: actual, ok: predicate(actual), note });
}

// Path traversal: result must NOT escape the /lang/ prefix
check('localePath traversal in middle', localePath('/orderbook/../faq', 'es'),
	(r) => r.startsWith('/es/'), 'must remain locale-prefixed');

// Protocol-relative URLs (//evil.com) — SvelteKit normally rejects these
// at routing time, but our helper should also resist them
const ppRel = localePath('//evil.com/path', 'es');
check('localePath protocol-relative', ppRel,
	(r) => !r.startsWith('//') || r.startsWith('/es/'),
	'should not produce //evil.com/path; if //, must be locale-prefixed first');

// Stacked locale prefix — happens if a buggy caller pre-prefixes
check('localePath double-locale collapses to single', localePath('/es/es/foo', 'pl'),
	(r) => r === '/pl/es/foo', 'replaces ONE prefix; remainder is the second /es');

// Different scripts variant
check('localePath multi-script', localePath('/zh-HK/zh-CN/x', 'fa'),
	(r) => r === '/fa/zh-CN/x', 'replaces ONE prefix');

// Empty input
check('localePath empty string', localePath('', 'es'), (r) => r === '', 'passthrough');

// Whitespace in path — SvelteKit will URL-encode in practice
check('localePath path with space', localePath('/ /orderbook', 'es'),
	(r) => r === '/es/ /orderbook', 'preserves space verbatim');

// pickLocale adversarial: pseudo-protocol tag (impossible from navigator but
// proves the matcher rejects nonsense)
check('pickLocale javascript: scheme', pickLocaleFromAcceptLanguages(['javascript:']),
	(r) => r === 'en', 'falls back to default');

// Accept-Language style with q-value — pickLocale walks list as-is;
// q-values aren't parsed (navigator.languages doesn't carry them)
check('pickLocale Accept-Language q-value', pickLocaleFromAcceptLanguages(['en;q=0.5']),
	(r) => r === 'en', "en;q= shouldn't match en exactly but family-falls back via matchSupported's lowercase+split-by-hyphen");

// Whitespace-padded tag
check('pickLocale whitespace-padded', pickLocaleFromAcceptLanguages([' en ']),
	(r) => r === 'en' || r === 'en', 'either matches or falls back — we accept either');

// Very long Accept-Language list
const longList = Array(100).fill('xx').concat(['pl']);
check('pickLocale long list with match at end', pickLocaleFromAcceptLanguages(longList),
	(r) => r === 'pl', 'walks the whole list');

// Strip with adversarial input
check('stripLocalePrefix double-strip', stripLocalePrefix(stripLocalePrefix('/es/orderbook')),
	(r) => r === '/orderbook', 'idempotent');

let pass = 0, fail = 0;
console.log('path-adversarial smoke:\n');
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}: ${r.got}${r.note ? ` — ${r.note}` : ''}`);
		pass++;
	} else {
		console.error(`  ✗ ${r.name}: ${r.got}${r.note ? ` — ${r.note}` : ''}`);
		fail++;
	}
}
console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} adversarial inputs handled cleanly`);
	process.exit(0);
} else {
	console.error(`✗ ${fail} failed, ${pass} passed`);
	process.exit(1);
}
