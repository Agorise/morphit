#!/usr/bin/env tsx
/**
 * short-form-en-fallback-floor smoke — Part 122 cp81
 * (LL #82 / O-28).
 *
 * Sibling defense to cp80-O26 (long-form-en-fallback-floor).
 * Covers the next-down length class.
 *
 * Length tiers and policy:
 *
 *   |  length range   |     class       |    backlog-locale policy        |
 *   |-----------------|-----------------|---------------------------------|
 *   |   < 50 chars    |    tiny         |    EN-fallback permitted        |
 *   |  50 – 199 chars |    short-form   |    ZERO EN-fallback (THIS SMOKE)|
 *   |  >= 200 chars   |    long-form    |    ZERO EN-fallback (cp80-O26)  |
 *
 * Why the tiers:
 *
 *   < 50 ch tier — these are tickers (BTC, XMR), brand names
 *     (F-Droid, Cake Wallet, Arbitrum One), single-token UI labels
 *     (Chat, Slot), format strings ({min} – {max} {fiat}, <1m),
 *     and protocol identifiers (USDT-ERC20).  Translating these
 *     would either change the meaning (a ticker is not a name) or
 *     add zero comprehension value (most users globally know what
 *     "Chat" means).  Memory #29's original short-form carve-out
 *     stands for this tier.
 *
 *   50–199 ch tier — these are sentences of UI prose: button
 *     labels with explanatory subtext, modal headlines, in-line
 *     hints, short FAQ-card titles, error messages, banner copy.
 *     A user genuinely benefits from seeing these in their
 *     language.  cp76–cp80 closed long-form (>=200 ch) translation
 *     across the 6 backlog locales; community-translation passes
 *     across cp1–cp79 incidentally also closed the short-form
 *     tier (verified by inventory at cp81 — 0 EN-fallback short-
 *     form keys in any backlog locale).  This smoke locks that
 *     state in: future UI prose additions in this tier must
 *     translate in all 6 backlog locales, not just rely on the
 *     EN-fallback escape valve.
 *
 *   >= 200 ch tier — FAQ answers, privacy guides, long
 *     explanatory bodies.  Covered by cp80-O26.
 *
 * Rule:
 *
 *   For every key in en.json with `50 <= len(value) < 200` AND
 *   containing at least one alphabetic character (excludes pure
 *   format strings like `{currency} {amount}` and number-pattern
 *   strings), the value in EVERY one of the 6 backlog locales
 *   (it, pl, ru, fa, zh-CN, zh-HK) MUST NOT be byte-identical to
 *   the EN value.
 *
 * Mutation tests:
 *
 *   M-151: replace any short-form (50-199 ch) value in any
 *     backlog locale JSON with its EN-equivalent → smoke fires
 *     naming the key + locale.
 *   M-152: add a new short-form UI string to en.json without
 *     translating in one backlog locale → smoke fires.
 *   M-153: add a tiny (<50 ch) EN-only string → smoke ignores
 *     (tier policy: tiny tier permits EN-fallback).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BACKLOG_LOCALES = ['it', 'pl', 'ru', 'fa', 'zh-CN', 'zh-HK'] as const;
const SHORT_MIN = 50;
const SHORT_MAX = 200; // exclusive

interface JsonObject {
	[k: string]: string | JsonObject;
}

function flatten(obj: JsonObject, prefix = ''): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k in obj) {
		const v = obj[k];
		const path = prefix ? `${prefix}.${k}` : k;
		if (typeof v === 'string') out[path] = v;
		else if (v && typeof v === 'object') Object.assign(out, flatten(v, path));
	}
	return out;
}

// Resolve relative to the apps/web directory.
const root = resolve(import.meta.dirname, '..');
const localesDir = resolve(root, 'src/lib/i18n/locales');

const en: Record<string, string> = flatten(
	JSON.parse(readFileSync(resolve(localesDir, 'en.json'), 'utf8'))
);

// Short-form keys: 50 <= len(en) < 200 AND contains at least one
// alphabetic char (so pure format strings like '{a} — {b}' don't
// get pulled in — they have nothing to translate).
const ALPHA = /[A-Za-z\u00C0-\u024F]/;
const shortFormEnKeys: { key: string; en: string }[] = [];
for (const [key, value] of Object.entries(en)) {
	if (value.length < SHORT_MIN || value.length >= SHORT_MAX) continue;
	if (!ALPHA.test(value)) continue;
	shortFormEnKeys.push({ key, en: value });
}

const violations: { key: string; locale: string; len: number }[] = [];
for (const locale of BACKLOG_LOCALES) {
	const localePath = resolve(localesDir, `${locale}.json`);
	const localeFlat: Record<string, string> = flatten(
		JSON.parse(readFileSync(localePath, 'utf8'))
	);
	for (const { key, en: enVal } of shortFormEnKeys) {
		const localeVal = localeFlat[key];
		if (localeVal === undefined) {
			// Parity violation — different smoke catches this
			// (i18n-locale-parity-smoke).  Don't double-flag.
			continue;
		}
		if (localeVal === enVal) {
			violations.push({ key, locale, len: enVal.length });
		}
	}
}

const pairCount = shortFormEnKeys.length * BACKLOG_LOCALES.length;
console.log('\n── short-form-en-fallback-floor smoke (cp81 LL #82 / O-28) ──\n');
console.log(
	`▸ Found ${shortFormEnKeys.length} short-form EN keys (50 ≤ ch < 200, with alpha content)\n`
);

if (violations.length === 0) {
	console.log(
		`  ✓ every short-form key (50 ≤ ch < 200) is natively translated in all 6 backlog locales (${shortFormEnKeys.length} keys × ${BACKLOG_LOCALES.length} locales = ${pairCount} translation pairs verified)`
	);
	console.log(`\n1 passed, 0 failed (1 total)`);
	console.log(`✓ all 1 short-form-en-fallback-floor scenarios passed`);
} else {
	console.log(
		`  ✗ ${violations.length} short-form EN-fallback violation${violations.length > 1 ? 's' : ''} in backlog locales:`
	);
	for (const v of violations.slice(0, 20)) {
		console.log(`      ${v.locale} :: ${v.key} (${v.len} ch)`);
	}
	if (violations.length > 20) {
		console.log(`      ... +${violations.length - 20} more`);
	}
	console.log(`\n0 passed, 1 failed (1 total)`);
	console.log(`✗ short-form-en-fallback-floor: 1 scenarios failed`);
	process.exit(1);
}
