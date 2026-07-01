#!/usr/bin/env tsx
/**
 * seo-routes-i18n-all-locales smoke — Part 122 cp74 (LL #74 / O-22).
 *
 * The web vitest test `apps/web/src/lib/seo/routes.test.ts` already
 * verifies that every route in `apps/web/src/lib/seo/routes.ts` has
 * a matching `seo.<key>.title` and `seo.<key>.description` in
 * en.json.  That test caught cp73-D11 (missing seo.privacy_index
 * keys) — but only AFTER cp73 extended cp71-O19 vitest-must-pass
 * to monitor the web workspace.
 *
 * This smoke generalizes the same check to ALL 10 locales, not just
 * en.json.  Without it, a route could ship with English SEO tags
 * but empty/undefined tags in Spanish, French, etc — a silent
 * locale-parity violation invisible to the user but visible to
 * search engines crawling /es/privacy and getting empty meta.
 *
 * Self-test: temporarily delete `seo.privacy_index.title` from any
 * locale → smoke fires naming the locale + the missing key.
 *
 * Mutation test M-145 (this smoke's verification):
 *   - Remove the title from one locale → smoke fires.
 *   - Restore → smoke passes.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── seo-routes-i18n-all-locales smoke (cp74 LL #74 / O-22) ──\n');

// Parse the routes.ts file — extract every (key, indexable) tuple.
// We need ALL routes (not just indexable=true) because the <Head />
// component renders SEO meta for dynamic / non-indexable routes too.
const routesPath = join(REPO_ROOT, 'apps/web/src/lib/seo/routes.ts');
const routesSrc = readFileSync(routesPath, 'utf-8');

// Match patterns like:
//   { path: '/foo', key: 'foo_key', indexable: true, ... }
//   path: '/foo', key: 'foo_key', ...
// Use a tolerant regex that finds `key: 'xxx'` occurrences.
const keyMatches = Array.from(routesSrc.matchAll(/\bkey:\s*['"]([a-z_]+)['"]/g));
const routeKeys = Array.from(new Set(keyMatches.map((m) => m[1]!)));
console.log(`▸ Found ${routeKeys.length} unique route keys in apps/web/src/lib/seo/routes.ts\n`);

// Load every locale file and check coverage.
const localesDir = join(REPO_ROOT, 'apps/web/src/lib/i18n/locales');
const localeFiles = readdirSync(localesDir)
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.replace('.json', ''));

interface MissingEntry {
	readonly locale: string;
	readonly key: string;
	readonly field: 'title' | 'description';
}
const missing: MissingEntry[] = [];

for (const locale of localeFiles) {
	const path = join(localesDir, `${locale}.json`);
	let json: { seo?: Record<string, { title?: unknown; description?: unknown }> };
	try {
		json = JSON.parse(readFileSync(path, 'utf-8'));
	} catch (e) {
		fail(`${locale}.json parses as JSON`, String((e as Error).message));
		continue;
	}
	const seo = json.seo ?? {};
	for (const key of routeKeys) {
		const entry = seo[key];
		if (!entry || typeof entry !== 'object') {
			missing.push({ locale, key, field: 'title' });
			missing.push({ locale, key, field: 'description' });
			continue;
		}
		if (typeof entry.title !== 'string' || entry.title.length === 0) {
			missing.push({ locale, key, field: 'title' });
		}
		if (typeof entry.description !== 'string' || entry.description.length === 0) {
			missing.push({ locale, key, field: 'description' });
		}
	}
}

if (missing.length === 0) {
	pass(`every route key has seo.<key>.{title,description} in all ${localeFiles.length} locales`);
} else {
	// Group by locale for readability
	const byLocale = new Map<string, MissingEntry[]>();
	for (const m of missing) {
		const list = byLocale.get(m.locale) ?? [];
		list.push(m);
		byLocale.set(m.locale, list);
	}
	for (const [locale, entries] of byLocale.entries()) {
		const sample = entries.slice(0, 5).map((e) => `seo.${e.key}.${e.field}`).join(', ');
		const more = entries.length > 5 ? ` (and ${entries.length - 5} more)` : '';
		fail(
			`${locale}.json has all route SEO keys`,
			`${entries.length} missing: ${sample}${more}`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nseo-routes-i18n-all-locales smoke FAILED');
	console.error('Memory rule: locale parity — every user-facing string change must be translated into all 10 locales in the same turn.');
	process.exit(1);
}
console.log(`✓ all ${total} seo-routes-i18n-all-locales scenarios passed`);
