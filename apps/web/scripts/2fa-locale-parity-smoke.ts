#!/usr/bin/env tsx
/**
 * Smoke: TOTP-2FA locale parity — no English string leaks into
 * non-English locales.
 *
 * The Morphit standing rule is that EVERY user-facing string in
 * a non-EN locale must be translated, not left as the EN
 * fallback.  This smoke walks the `settings.totp.*` subtree
 * across all 10 locales and refuses any string that is
 * byte-identical to its EN counterpart (with whitelist
 * exceptions for genuinely-shared tokens: 'Morphit', 'Aegis',
 * '2FAS', 'Ente Auth', etc., where translation would be wrong).
 *
 * Also asserts structural parity: every key present in the EN
 * tree must be present in every other locale's tree, recursively.
 *
 * Tamper: deleting `settings.totp.unlock_prompt.heading` from
 * fr.json → fails.  Copy-pasting an EN string into pl.json
 * verbatim → fails.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const LOCALES_DIR = join(REPO_ROOT, 'apps/web/src/lib/i18n/locales');
const EN = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'));
const NON_EN_LOCALES = readdirSync(LOCALES_DIR)
	.filter((f) => f.endsWith('.json') && f !== 'en.json')
	.sort();

/** Strings that ARE expected to be identical across all
 *  locales — proper nouns, brand names, app names, URL
 *  placeholders.  These don't fail the byte-identity check. */
const SHARED_TOKENS_OK = new Set<string>([
	'Morphit',
	'Aegis',
	'2FAS',
	'Ente Auth',
	'Google Authenticator',
	'Microsoft Authenticator',
	'Authy',
	'TOTP',
	'FIDO2',
	'WebAuthn',
	'YubiKey',
	'000000',
	'XXXX-XXXX',
	'000000 or XXXX-XXXX'
]);

/** Walk a JSON tree and return [path, value] for every leaf string. */
function* walkStrings(obj: unknown, path: string[] = []): Generator<[string[], string]> {
	if (typeof obj === 'string') {
		yield [path, obj];
		return;
	}
	if (obj && typeof obj === 'object') {
		for (const [k, v] of Object.entries(obj)) {
			yield* walkStrings(v, [...path, k]);
		}
	}
}

function get(obj: unknown, path: string[]): unknown {
	let cur: unknown = obj;
	for (const segment of path) {
		if (cur && typeof cur === 'object' && segment in (cur as Record<string, unknown>)) {
			cur = (cur as Record<string, unknown>)[segment];
		} else {
			return undefined;
		}
	}
	return cur;
}

const enTotp = (EN as { settings: { totp: unknown } }).settings.totp;
if (!enTotp || typeof enTotp !== 'object') {
	console.error('en.json does not have settings.totp tree');
	process.exit(1);
}

let failures = 0;
let passes = 0;

console.log('2fa-locale-parity-smoke\n');

for (const localeFile of NON_EN_LOCALES) {
	const lc = JSON.parse(readFileSync(join(LOCALES_DIR, localeFile), 'utf8'));
	const localeTotp = (lc as { settings?: { totp?: unknown } })?.settings?.totp;
	if (!localeTotp || typeof localeTotp !== 'object') {
		failures += 1;
		console.error(`  ✗ ${localeFile} is missing settings.totp tree entirely`);
		continue;
	}

	let localePass = 0;
	let localeFail = 0;

	// Structural parity: every key in EN tree exists in this locale's tree.
	for (const [path] of walkStrings(enTotp, [])) {
		const localeVal = get(localeTotp, path);
		if (typeof localeVal !== 'string') {
			localeFail += 1;
			console.error(
				`  ✗ ${localeFile}: missing or non-string key settings.totp.${path.join('.')}`
			);
		}
	}

	// Byte-identity check: a non-EN string equal to EN is a likely
	// untranslated fallback.  Whitelist shared tokens that are
	// expected to be identical (Morphit, Aegis, app names).
	for (const [path, enStr] of walkStrings(enTotp, [])) {
		const localeStr = get(localeTotp, path);
		if (typeof localeStr !== 'string') continue;
		if (localeStr === enStr) {
			if (SHARED_TOKENS_OK.has(enStr)) {
				localePass += 1;
				continue;
			}
			// Short strings under 4 chars are often genuine shared
			// tokens (yes/no/ok/etc); don't flag.
			if (enStr.length < 4) {
				localePass += 1;
				continue;
			}
			localeFail += 1;
			console.error(
				`  ✗ ${localeFile}: settings.totp.${path.join('.')} is byte-identical to EN: ${JSON.stringify(enStr).slice(0, 80)}`
			);
		} else {
			localePass += 1;
		}
	}

	if (localeFail === 0) {
		console.log(`  ✓ ${localeFile}: ${localePass} strings verified`);
		passes += 1;
	} else {
		console.error(`  ✗ ${localeFile}: ${localeFail} failures`);
		failures += 1;
	}
}

console.log(`\n${passes} locales passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} 2fa-locale-parity-smoke scenarios passed`);
