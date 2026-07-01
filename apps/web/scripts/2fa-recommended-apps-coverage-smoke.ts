#!/usr/bin/env tsx
/**
 * Smoke: TOTP-2FA recommended-apps i18n coverage across all 10
 * locales.
 *
 * For every app in RECOMMENDED_AUTHENTICATOR_APPS, every locale
 * MUST carry a `settings.totp.recommended_apps.<i18nKey>.tagline`
 * string.  Same invariant for NOT_RECOMMENDED.  Missing or
 * empty strings fail the smoke.  Also verifies that the
 * `officialUrl` and `sourceUrl` fields are HTTPS, non-empty,
 * and not `localhost`.
 *
 * Tamper: adding a new app to RECOMMENDED_AUTHENTICATOR_APPS
 * without adding its i18n strings → fails.  Setting an app's
 * `officialUrl` to `http://localhost:8080` → fails.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const RECOMMENDED_APPS_TS = readFileSync(
	join(REPO_ROOT, 'apps/web/src/lib/auth/recommendedAuthenticatorApps.ts'),
	'utf8'
);
const LOCALES_DIR = join(REPO_ROOT, 'apps/web/src/lib/i18n/locales');
const LOCALE_FILES = readdirSync(LOCALES_DIR)
	.filter((f) => f.endsWith('.json'))
	.sort();

interface AppRow {
	readonly name: string;
	readonly i18nKey: string;
	readonly officialUrl: string;
	readonly sourceUrl: string;
}

function parseAppsBlock(arrayName: string): AppRow[] {
	const startIdx = RECOMMENDED_APPS_TS.indexOf(arrayName);
	if (startIdx < 0) {
		throw new Error(`Could not locate ${arrayName}`);
	}
	const arrOpen = RECOMMENDED_APPS_TS.indexOf('[', startIdx);
	const endIdx = RECOMMENDED_APPS_TS.indexOf('];', arrOpen);
	if (arrOpen < 0 || endIdx < 0) {
		throw new Error(`Malformed ${arrayName} array`);
	}
	const body = RECOMMENDED_APPS_TS.slice(arrOpen + 1, endIdx);
	const rows: AppRow[] = [];
	// Brace-depth walk to split top-level entries.
	let depth = 0;
	let entryStart = -1;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === '{') {
			if (depth === 0) entryStart = i;
			depth += 1;
		} else if (ch === '}') {
			depth -= 1;
			if (depth === 0 && entryStart >= 0) {
				const entry = body.slice(entryStart, i + 1);
				const name = entry.match(/name:\s*'([^']+)'/)?.[1] ?? '';
				const i18nKey = entry.match(/i18nKey:\s*'([^']+)'/)?.[1] ?? '';
				const officialUrl = entry.match(/officialUrl:\s*'([^']+)'/)?.[1] ?? '';
				const sourceUrl = entry.match(/sourceUrl:\s*'([^']+)'/)?.[1] ?? '';
				if (name && i18nKey) {
					rows.push({ name, i18nKey, officialUrl, sourceUrl });
				}
				entryStart = -1;
			}
		}
	}
	return rows;
}

let failures = 0;
let passes = 0;

function expect(label: string, cond: boolean): void {
	if (cond) {
		passes += 1;
	} else {
		failures += 1;
		console.error(`  ✗ ${label}`);
	}
}

console.log('2fa-recommended-apps-coverage-smoke\n');

const recommended = parseAppsBlock('RECOMMENDED_AUTHENTICATOR_APPS');
const notRecommended = parseAppsBlock('NOT_RECOMMENDED_AUTHENTICATOR_APPS');

console.log(`recommended apps: ${recommended.length}`);
console.log(`not-recommended apps: ${notRecommended.length}`);

// URL hygiene
console.log('\nURL hygiene:');
for (const app of recommended) {
	expect(`${app.name}: officialUrl is https://`, app.officialUrl.startsWith('https://'));
	expect(`${app.name}: officialUrl is not localhost`, !app.officialUrl.includes('localhost'));
	expect(`${app.name}: sourceUrl is https://`, app.sourceUrl.startsWith('https://'));
	expect(`${app.name}: sourceUrl is not localhost`, !app.sourceUrl.includes('localhost'));
}

// i18n coverage
console.log('\ni18n coverage:');
for (const localeFile of LOCALE_FILES) {
	const d = JSON.parse(readFileSync(join(LOCALES_DIR, localeFile), 'utf8'));
	const totp = d?.settings?.totp;
	if (!totp) {
		failures += 1;
		console.error(`  ✗ ${localeFile} is missing settings.totp tree`);
		continue;
	}
	const recTree = totp.recommended_apps ?? {};
	const notRecTree = totp.not_recommended_apps ?? {};

	for (const app of recommended) {
		const tagline = recTree?.[app.i18nKey]?.tagline;
		expect(
			`${localeFile}: settings.totp.recommended_apps.${app.i18nKey}.tagline exists and is non-empty`,
			typeof tagline === 'string' && tagline.length > 0
		);
	}
	for (const app of notRecommended) {
		const sub = notRecTree?.[app.i18nKey];
		expect(
			`${localeFile}: settings.totp.not_recommended_apps.${app.i18nKey}.name exists`,
			typeof sub?.name === 'string' && sub.name.length > 0
		);
		expect(
			`${localeFile}: settings.totp.not_recommended_apps.${app.i18nKey}.reason exists`,
			typeof sub?.reason === 'string' && sub.reason.length > 0
		);
	}
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} 2fa-recommended-apps-coverage-smoke scenarios passed`);
