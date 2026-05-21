#!/usr/bin/env tsx
/**
 * long-form-en-fallback-floor smoke — Part 122 cp80 (LL #80 / O-26).
 *
 * Closes the Memory #29 backlog state for long-form content.
 *
 * Memory #29 originally permitted EN-fallback for 6 "community-
 * translation backlog" locales (it/pl/ru/fa/zh-CN/zh-HK) while
 * es/fr/de were policy-natively-translated.  The existing
 * `i18n-translation-completeness-smoke` (cp45 LL #45) enforced
 * the native-locale policy for es/fr/de but explicitly skipped
 * the 6 backlog locales (`POLICY_FALLBACK_LOCALES` set, line
 * ~1016 of that smoke).
 *
 * cp76-cp80 closed the long-form portion of the Memory #29
 * backlog: 13 batches of translations (~150 strings) covering
 * every key with EN length ≥ 200 chars across all 6 backlog
 * locales.  This smoke locks in that completion: future long-
 * form content additions MUST translate to all 9 non-English
 * locales, not just the es/fr/de native trio.
 *
 * Rule:
 *   For every key in en.json with `len(value) >= 200` AND
 *   containing at least one alphabetic character (excludes
 *   pure format strings like `{currency} {amount}`), the
 *   value in EVERY one of the 6 backlog locales (it, pl, ru,
 *   fa, zh-CN, zh-HK) MUST NOT be byte-identical to the EN
 *   value.
 *
 * Why 200 chars:
 *   - Tickers, brand names, addresses (e.g. "BTC", "Pirate
 *     Chain", "MetaMask") legitimately stay Latin/English in
 *     non-Latin scripts and are short (<50 ch).
 *   - UI labels and button text typically <100 ch; the
 *     community-translation backlog covers these via separate
 *     workflows, and forcing them all today would be heavy
 *     scope creep.
 *   - 200+ ch keys are FAQ answers, privacy-guide bodies, and
 *     long-form explanatory copy — the bulk of what users
 *     actually read in their language.  These were the explicit
 *     scope of the cp76-cp80 batch effort.
 *
 * Why this is a real defense, not a speculative one:
 *   - The backlog existed (~150 long-form keys at cp68 entry).
 *   - The backlog was closed via 13 explicit batches.
 *   - Without this smoke, future long-form content (new FAQ
 *     entries, new privacy-guide sections, new asset additions)
 *     could re-introduce EN-fallback in the 6 backlog locales
 *     silently and the `i18n-translation-completeness-smoke`
 *     wouldn't catch it (those locales are skipped by design).
 *   - This smoke is the regression gate that prevents the
 *     backlog from re-opening.
 *
 * Mutation test M-149:
 *   - Replace any long-form (≥200 ch) value in any backlog
 *     locale JSON with its EN-equivalent → smoke fires naming
 *     the key + locale.
 *   - Add a new FAQ entry to en.json with ≥200 ch but forget
 *     to translate it in one backlog locale → smoke fires.
 *   - Add a new EN-only string with <200 ch → smoke ignores
 *     it (correct; that's the i18n-completeness smoke's job).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const LOC_DIR = join(REPO_ROOT, 'apps/web/src/lib/i18n/locales');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── long-form-en-fallback-floor smoke (cp80 LL #80 / O-26) ──\n');

/** Threshold: keys with EN value ≥ this many characters MUST be
 *  natively translated in all 9 non-English locales (not just
 *  the es/fr/de native trio). */
const LONG_FORM_THRESHOLD_CHARS = 200;

/** The 6 backlog locales the older Memory #29 policy permitted
 *  to EN-fallback.  This smoke says: not for long-form content
 *  anymore. */
const BACKLOG_LOCALES = ['it', 'pl', 'ru', 'fa', 'zh-CN', 'zh-HK'] as const;

interface FlatKV { [key: string]: string }

function flatten(obj: unknown, prefix = ''): FlatKV {
	const out: FlatKV = {};
	if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			const kp = prefix ? `${prefix}.${k}` : k;
			if (typeof v === 'string') out[kp] = v;
			else if (v && typeof v === 'object') Object.assign(out, flatten(v, kp));
		}
	}
	return out;
}

function loadLocale(locale: string): FlatKV {
	const path = join(LOC_DIR, `${locale}.json`);
	const raw = readFileSync(path, 'utf-8');
	return flatten(JSON.parse(raw));
}

let en: FlatKV;
try {
	en = loadLocale('en');
} catch (e) {
	fail('en.json loadable', (e as Error).message);
	process.exit(1);
}

const backlogData = new Map<string, FlatKV>();
for (const locale of BACKLOG_LOCALES) {
	try {
		backlogData.set(locale, loadLocale(locale));
	} catch (e) {
		fail(`${locale}.json loadable`, (e as Error).message);
	}
}

if (failed > 0) {
	process.exit(1);
}

// Identify long-form keys in EN.
const longFormKeys: Array<{ key: string; len: number }> = [];
for (const [k, v] of Object.entries(en)) {
	if (!v.trim()) continue;
	// Pure format/identifier strings (no alpha chars) are exempt —
	// e.g. "{amount} {ticker}" or numeric placeholders.
	if (![...v].some((c) => /[a-zA-Z]/.test(c))) continue;
	if (v.length >= LONG_FORM_THRESHOLD_CHARS) {
		longFormKeys.push({ key: k, len: v.length });
	}
}

console.log(`▸ Found ${longFormKeys.length} long-form EN keys (≥ ${LONG_FORM_THRESHOLD_CHARS} chars with alpha content)\n`);

// Walk every long-form key × every backlog locale.  Any EN-fallback
// is a smoke failure.
interface Violation { key: string; locale: string; len: number }
const violations: Violation[] = [];

for (const { key, len } of longFormKeys) {
	const enValue = en[key]!;
	for (const locale of BACKLOG_LOCALES) {
		const localeData = backlogData.get(locale)!;
		const localeValue = localeData[key];
		// Missing in locale → structural parity issue, separate
		// smoke's job (i18n-locale-registry-smoke).  Not our concern
		// here; we check ONLY byte-identical EN-fallback.
		if (localeValue === undefined) continue;
		if (localeValue === enValue) {
			violations.push({ key, locale, len });
		}
	}
}

if (violations.length === 0) {
	pass(`every long-form key (≥ ${LONG_FORM_THRESHOLD_CHARS} ch) is natively translated in all 6 backlog locales (${longFormKeys.length} keys × 6 locales = ${longFormKeys.length * 6} translation pairs verified)`);
} else {
	// Group by locale for readable output.
	const byLocale = new Map<string, Violation[]>();
	for (const v of violations) {
		const list = byLocale.get(v.locale) ?? [];
		list.push(v);
		byLocale.set(v.locale, list);
	}
	for (const [locale, vs] of byLocale.entries()) {
		const sample = vs.slice(0, 5);
		const sampleStr = sample.map((v) => `${v.key} (${v.len} ch)`).join('\n      ');
		const more = vs.length > 5 ? `\n      … and ${vs.length - 5} more` : '';
		fail(
			`${locale} has no long-form EN-fallback`,
			`${vs.length} key(s) in ${locale}.json are byte-identical to EN value:\n      ${sampleStr}${more}\n\n` +
				`      Fix: translate these keys natively.  EN-fallback for long-form\n` +
				`      content is no longer permitted in the 6 backlog locales as of\n` +
				`      cp80 (the cp76-cp80 batch effort closed this backlog).\n` +
				`      Add the translation; do not add to an allow-list.`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nlong-form-en-fallback-floor smoke FAILED');
	console.error('cp80-O26: the Memory #29 long-form backlog was closed at cp80.  Long-form content (≥200 ch) cannot regress to EN-fallback in it/pl/ru/fa/zh-CN/zh-HK.');
	process.exit(1);
}
console.log(`✓ all ${total} long-form-en-fallback-floor scenarios passed`);
