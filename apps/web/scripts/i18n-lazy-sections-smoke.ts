#!/usr/bin/env tsx
/**
 * i18n-lazy-sections-smoke (v1.20.2, PageSpeed).
 *
 * The FAQ, the privacy guides, "run a node" and the cheat sheet are cut out of
 * the locale bundle every page downloads and load with their own page
 * (src/lib/i18n/lazySections.ts). That is only safe while:
 *
 *   L-1  every lazy section exists in en.json;
 *   L-2  no file outside the section's routes reads its keys — such a page
 *        would show raw keys ("faq.title") — except FaqSearch.svelte and
 *        faqIndex.ts, which only the FAQ route may import as values;
 *   L-3  every route of a section loads it in its +page.ts
 *        (loadI18nSections(lang, '<section>'));
 *   L-4  the i18n runtime registers only the `core` part up front and never
 *        imports a whole locale file;
 *   L-5  vite.config.js installs the plugin that serves the parts.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAZY_SECTIONS, LAZY_SECTION_NAMES } from '../src/lib/i18n/lazySections.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src');
const ROUTES = join(SRC, 'routes', '[lang]');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
};

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		if (statSync(p).isDirectory()) return walk(p);
		return /\.(ts|svelte|js)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
	});
}

console.log('\n── i18n-lazy-sections smoke ──');
const en = JSON.parse(readFileSync(join(SRC, 'lib/i18n/locales/en.json'), 'utf8')) as Record<
	string,
	unknown
>;
const missing = LAZY_SECTION_NAMES.filter((s) => !Object.hasOwn(en, s));
check(
	`L-1 every lazy section is in en.json (${LAZY_SECTION_NAMES.join(', ')})`,
	missing.length === 0,
	missing.join(', ')
);

const files = walk(SRC);
const rel = (p: string): string => relative(WEB, p).split('\\').join('/');
// Files allowed to read FAQ keys although they live outside the route: the FAQ
// page's own component and index, which only the FAQ route may import.
const FAQ_HELPERS = ['src/lib/components/FaqSearch.svelte', 'src/lib/utils/faqIndex.ts'];
for (const s of LAZY_SECTION_NAMES) {
	const routeDirs = LAZY_SECTIONS[s].routes.map((r) => join(ROUTES, r) + '/');
	const keyRe = new RegExp(`['"\`]${s}\\.[A-Za-z_$]`);
	const outside = files.filter(
		(f) =>
			keyRe.test(readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')) &&
			!routeDirs.some((d) => f.startsWith(d)) &&
			!(s === 'faq' && FAQ_HELPERS.includes(rel(f)))
	);
	check(
		`L-2 '${s}.*' keys are read only by /${LAZY_SECTIONS[s].routes.join(', /')}`,
		outside.length === 0,
		`outside the route: ${outside.map(rel).join(', ')}`
	);
}
{
	const faqDir = join(ROUTES, 'faq') + '/';
	const valueImporters = files.filter((f) => {
		const t = readFileSync(f, 'utf8');
		return (
			!FAQ_HELPERS.includes(rel(f)) &&
			(/import\s+FaqSearch\s+from/.test(t) ||
				/import\s*\{(?![^}]*\btype\b)[^}]*\}\s*from\s*['"]\$utils\/faqIndex['"]/.test(t) ||
				/import\s*\{[^}]*\b(?!type\s)(faqEntries|buildFaq\w*)\b[^}]*\}\s*from\s*['"]\$utils\/faqIndex['"]/.test(
					t
				))
		);
	});
	const bad = valueImporters.filter((f) => !f.startsWith(faqDir));
	check(
		'L-2 FaqSearch and faqIndex (as values) are imported only by the FAQ route',
		bad.length === 0,
		bad.map(rel).join(', ')
	);
}

for (const s of LAZY_SECTION_NAMES) {
	for (const r of LAZY_SECTIONS[s].routes) {
		const pageDirs = walk(join(ROUTES, r))
			.filter((f) => f.endsWith('+page.svelte'))
			.map((f) => dirname(f));
		for (const d of pageDirs) {
			const ts = join(d, '+page.ts');
			const body = existsSync(ts) ? readFileSync(ts, 'utf8') : '';
			check(
				`L-3 ${rel(d)}/+page.ts loads '${s}'`,
				new RegExp(`loadI18nSections\\([^)]*['"]${s}['"]`).test(body) &&
					/await\s+loadI18nSections/.test(body),
				existsSync(ts) ? 'no `await loadI18nSections(lang, …)` for it' : 'no +page.ts'
			);
		}
	}
}

const idx = readFileSync(join(SRC, 'lib/i18n/index.ts'), 'utf8');
check(
	'L-4 the runtime registers the core part up front and never imports a whole locale file',
	/from\s+'virtual:morphit-i18n-loaders'/.test(idx) &&
		/register\(\s*code\s*,\s*loaderFor\(\s*code\s*,\s*CORE_PART\s*\)\s*\)/.test(idx) &&
		!/import\(`\.\/locales\//.test(idx) &&
		!/from\s+'\.\/locales\/[^']+\.json'/.test(idx)
);
const vite = readFileSync(join(WEB, 'vite.config.js'), 'utf8');
check(
	'L-5 vite.config.js installs the morphit-i18n-sections plugin',
	/import\s*\{\s*i18nSections\s*\}\s*from\s*'\.\/scripts\/vite-i18n-sections\.ts'/.test(vite) &&
		/plugins:\s*\[[^\]]*i18nSections\(/.test(vite)
);

console.log(
	fail === 0
		? `\n✓ all ${pass} i18n-lazy-sections checks passed`
		: `\n✗ ${fail} FAILED, ${pass} passed`
);
process.exit(fail === 0 ? 0 : 1);
