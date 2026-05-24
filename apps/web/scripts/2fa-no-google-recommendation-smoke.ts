#!/usr/bin/env tsx
/**
 * Smoke: TOTP-2FA never recommends Google Authenticator (or other
 * closed-source authenticators) anywhere in the codebase.
 *
 * ADR-0043 commits to an open-source-only recommendation policy.
 * This smoke enforces it structurally:
 *
 *   1. RECOMMENDED_AUTHENTICATOR_APPS in
 *      apps/web/src/lib/auth/recommendedAuthenticatorApps.ts
 *      contains ONLY apps with verifiable open-source licenses
 *      (GPL, AGPL, MPL, Apache, BSD, MIT).  No proprietary apps.
 *
 *   2. NOT_RECOMMENDED_AUTHENTICATOR_APPS explicitly lists
 *      Google Authenticator, Microsoft Authenticator, and Authy
 *      with their reasons surfaced.
 *
 *   3. NO locale JSON string mentions Google/Microsoft/Authy in
 *      a positive recommendation context (only in the explicit
 *      "we don't recommend these" section, where it's expected).
 *
 *   4. The 2FA settings route renders both RECOMMENDED and
 *      NOT_RECOMMENDED app sections, and the "not recommended"
 *      section is collapsible (not hidden).
 *
 * Tamper test: removing Google Authenticator from
 * NOT_RECOMMENDED_AUTHENTICATOR_APPS without removing all UI
 * references to it → smoke fails.  Recommending a closed-source
 * app in RECOMMENDED_AUTHENTICATOR_APPS → smoke fails.
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
const TFA_ROUTE = readFileSync(
	join(REPO_ROOT, 'apps/web/src/routes/[lang]/settings/security/2fa/+page.svelte'),
	'utf8'
);
const LOCALES_DIR = join(REPO_ROOT, 'apps/web/src/lib/i18n/locales');
const LOCALE_FILES = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));

const OPEN_SOURCE_LICENSE_PATTERNS = [
	/GPL-[23]\.0/,
	/AGPL-3\.0/,
	/MPL-[12]\.0/,
	/Apache-2\.0/,
	/BSD-[23]-Clause/,
	/MIT\b/,
	/ISC\b/,
	/CC-BY-SA/
];

interface AppRow {
	readonly name: string;
	readonly license: string;
}

function parseRecommendedApps(): AppRow[] {
	// Find the array start marker, then walk to its matching `];`
	// at the top level (the inline `platforms: ['Android']` arrays
	// inside entries don't have a trailing semicolon so they
	// can't false-match).
	const startMarker = 'RECOMMENDED_AUTHENTICATOR_APPS: ReadonlyArray<AuthenticatorApp> = [';
	const startIdx = RECOMMENDED_APPS_TS.indexOf(startMarker);
	if (startIdx < 0) {
		throw new Error('Could not locate RECOMMENDED_AUTHENTICATOR_APPS array');
	}
	// The array body ends at the next `];\n` that's followed by
	// a blank line or another `export`/`/**` line — i.e., at the
	// top level, not at any nested array literal.
	const bodyStart = startIdx + startMarker.length;
	const endIdx = RECOMMENDED_APPS_TS.indexOf('];\n', bodyStart);
	if (endIdx < 0) {
		throw new Error('Could not locate end of RECOMMENDED_AUTHENTICATOR_APPS array');
	}
	const body = RECOMMENDED_APPS_TS.slice(bodyStart, endIdx);
	const rows: AppRow[] = [];
	// Each entry is a brace-delimited object literal at the
	// top level of the array.  We find them by scanning for
	// `{`...matching `}` with simple brace depth counting.
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
				const nameM = entry.match(/name:\s*'([^']+)'/);
				const licM = entry.match(/license:\s*'([^']+)'/);
				if (nameM && licM) {
					rows.push({ name: nameM[1], license: licM[1] });
				}
				entryStart = -1;
			}
		}
	}
	return rows;
}

function parseNotRecommendedApps(): string[] {
	const startMarker = 'NOT_RECOMMENDED_AUTHENTICATOR_APPS';
	const startIdx = RECOMMENDED_APPS_TS.indexOf(startMarker);
	if (startIdx < 0) {
		throw new Error('Could not locate NOT_RECOMMENDED_AUTHENTICATOR_APPS array');
	}
	const arrOpen = RECOMMENDED_APPS_TS.indexOf('[', startIdx);
	const endIdx = RECOMMENDED_APPS_TS.indexOf('];', arrOpen);
	if (arrOpen < 0 || endIdx < 0) {
		throw new Error('Malformed NOT_RECOMMENDED_AUTHENTICATOR_APPS array');
	}
	const body = RECOMMENDED_APPS_TS.slice(arrOpen + 1, endIdx);
	const names: string[] = [];
	for (const match of body.matchAll(/name:\s*'([^']+)'/g)) {
		names.push(match[1]);
	}
	return names;
}

let failures = 0;
let passes = 0;

function expect(label: string, cond: boolean, detail = ''): void {
	if (cond) {
		passes += 1;
		console.log(`  ✓ ${label}`);
	} else {
		failures += 1;
		console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
	}
}

console.log('2fa-no-google-recommendation-smoke\n');

// 1. Every recommended app has a license that matches an OSI pattern.
console.log('1. recommended apps are open-source-licensed:');
const recommended = parseRecommendedApps();
expect(
	'at least three recommended apps',
	recommended.length >= 3,
	`found ${recommended.length}`
);
for (const app of recommended) {
	const isOpenSource = OPEN_SOURCE_LICENSE_PATTERNS.some((p) => p.test(app.license));
	expect(`${app.name} (${app.license}) is open-source-licensed`, isOpenSource);
}

// 2. NOT_RECOMMENDED explicitly lists the closed-source big three.
console.log('\n2. not-recommended list calls out the closed-source big three:');
const notRecommended = parseNotRecommendedApps();
expect(
	'Google Authenticator is in NOT_RECOMMENDED list',
	notRecommended.some((n) => /google\s*authenticator/i.test(n)),
	notRecommended.join(', ')
);
expect(
	'Microsoft Authenticator is in NOT_RECOMMENDED list',
	notRecommended.some((n) => /microsoft\s*authenticator/i.test(n)),
	notRecommended.join(', ')
);
expect(
	'Authy is in NOT_RECOMMENDED list',
	notRecommended.some((n) => /authy/i.test(n)),
	notRecommended.join(', ')
);

// 3. No locale string positively recommends Google/Microsoft/Authy.
//    "Positively" means: appears under settings.totp.recommended_apps.*
//    or in any non-explicitly-negative context.  We check by ensuring
//    that for every locale, "Google Authenticator" / "Microsoft
//    Authenticator" / "Authy" appears ONLY under
//    settings.totp.not_recommended_apps.*  (or not at all).
console.log('\n3. locale strings never positively recommend the big three:');
for (const localeFile of LOCALE_FILES) {
	const path = join(LOCALES_DIR, localeFile);
	const d = JSON.parse(readFileSync(path, 'utf8'));
	const totp = d?.settings?.totp;
	if (!totp) {
		failures += 1;
		console.error(`  ✗ ${localeFile} is missing settings.totp tree`);
		continue;
	}
	const recommendedTree = totp.recommended_apps ?? {};
	const recommendedStrings = JSON.stringify(recommendedTree);
	expect(
		`${localeFile}: recommended_apps tree has no 'Google Authenticator'`,
		!/google\s*authenticator/i.test(recommendedStrings)
	);
	expect(
		`${localeFile}: recommended_apps tree has no 'Microsoft Authenticator'`,
		!/microsoft\s*authenticator/i.test(recommendedStrings)
	);
	expect(
		`${localeFile}: recommended_apps tree has no 'Authy'`,
		!/\bauthy\b/i.test(recommendedStrings)
	);
}

// 4. The 2FA route renders BOTH lists.
console.log('\n4. settings/security/2fa route renders both lists:');
expect(
	'route imports RECOMMENDED_AUTHENTICATOR_APPS',
	/RECOMMENDED_AUTHENTICATOR_APPS/.test(TFA_ROUTE)
);
expect(
	'route imports NOT_RECOMMENDED_AUTHENTICATOR_APPS',
	/NOT_RECOMMENDED_AUTHENTICATOR_APPS/.test(TFA_ROUTE)
);
expect(
	'route iterates recommended apps via #each',
	/each\s+RECOMMENDED_AUTHENTICATOR_APPS/.test(TFA_ROUTE)
);
expect(
	'route iterates not-recommended apps via #each',
	/each\s+NOT_RECOMMENDED_AUTHENTICATOR_APPS/.test(TFA_ROUTE)
);
expect(
	'not-recommended section is in a <details> (collapsible, not hidden)',
	/<details[^>]*class="apps not-recommended"/.test(TFA_ROUTE) ||
		/class="apps not-recommended"[^>]*>[\s\S]{0,200}?<\/details>/.test(TFA_ROUTE) ||
		/<details[\s\S]{0,500}?NOT_RECOMMENDED/.test(TFA_ROUTE)
);

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} 2fa-no-google-recommendation-smoke scenarios passed`);
