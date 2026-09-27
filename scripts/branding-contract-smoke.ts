#!/usr/bin/env tsx
/**
 * scripts/branding-contract-smoke.ts
 *
 * Per-instance branding (docs/BRANDING.md) is split across four places that
 * must agree, and nothing else would notice if they drifted:
 *
 *   - apps/web locale JSON: `{brand}` / `{brand|<default form>}` placeholders;
 *   - apps/web (runtime): src/lib/brand/*, and BRAND_OVERRIDABLE_PATHS in
 *     src/lib/net/dynamicPaths.ts (the service worker serves those
 *     stale-while-revalidate so a re-brand reaches returning visitors);
 *   - scripts/build-brand-slots.mjs (build): records every site-name slot and
 *     stamps the canonical <html> attributes;
 *   - apps/ops-cli src/lib/branding.ts (`morphit-ops branding apply`): rewrites
 *     exactly those slots/attributes and replaces exactly those files.
 *
 * Invariants:
 *   C-1  The files ops-cli may replace == the paths the SW revalidates.
 *   C-2  The canonical <html> attribute string is identical in the slot builder
 *        and in ops-cli (apply locates it byte for byte).
 *   C-3  Every overridable file ships in apps/web/static (so it is precached and
 *        exists on an unbranded instance), and the shipped brand.json is the
 *        default brand with the BETA marker on.
 *   C-4  Every `{brand…}` token in every locale is well-formed, and each
 *        `{brand|form}` default form is one the slot builder recognises
 *        (otherwise the build fails on an unpaired marker, or worse, a slot
 *        goes unrecorded).
 *   C-5  No translation names "Morphit" literally in a key whose English names
 *        only the site — that mention would stay "Morphit" on a re-branded
 *        site. (Omitting the name entirely is fine.)
 *   C-6  The canonical example from the request stays branded: the login
 *        title is "Sign in to {brand}".
 *   C-7  The SPA shell (index.html, on the on-chain tamper manifest) is
 *        protected in ops-cli, and the prerender templates' markers are paired.
 *   C-8  `--logo FILE`, `--name "X"` … take the next argument as their value
 *        (ops-cli's VALUE_FLAGS); otherwise X is dropped and the flag reads
 *        "true". Also covers payment-method add's documented flags.
 *   C-9  ops/bunkerweb/frontend/nginx.conf serves every brand asset no-cache.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_OVERRIDABLE_PATHS } from '../apps/web/src/lib/net/dynamicPaths.ts';
import {
	BRAND_TARGETS,
	PNG_ICONS,
	CANONICAL_HTML_ATTRS as OPS_ATTRS,
	isProtectedPath
} from '../apps/ops-cli/src/lib/branding.ts';
import { CANONICAL_HTML_ATTRS as BUILD_ATTRS, SLOT_FORM_SOURCE } from './build-brand-slots.mjs';
import { DEFAULT_BRAND_NAME, BRAND_PLACEHOLDER_RE } from '../packages/operator-config/src/brand.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(REPO, 'apps', 'web');
const LOCALES = join(WEB, 'src', 'lib', 'i18n', 'locales');

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (ok) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failed++;
	}
}

console.log('\n── branding-contract smoke (docs/BRANDING.md) ──\n');

// C-1
const opsPaths = new Set<string>([
	...Object.values(BRAND_TARGETS).map((p) => `/${p}`),
	...PNG_ICONS.map(([p]) => `/${p}`)
]);
const swPaths = new Set(BRAND_OVERRIDABLE_PATHS);
const onlyOps = [...opsPaths].filter((p) => !swPaths.has(p));
const onlySw = [...swPaths].filter((p) => !opsPaths.has(p));
check(
	'C-1: ops-cli BRAND_TARGETS + PNG_ICONS == web BRAND_OVERRIDABLE_PATHS',
	onlyOps.length === 0 && onlySw.length === 0,
	`only in ops-cli: ${onlyOps.join(', ') || '—'}; only in web: ${onlySw.join(', ') || '—'}`
);

// C-2
check(
	'C-2: canonical <html> brand attributes identical in build-brand-slots.mjs and ops-cli',
	BUILD_ATTRS === OPS_ATTRS && OPS_ATTRS.includes(`data-brand-name="${DEFAULT_BRAND_NAME}"`),
	`build: ${BUILD_ATTRS} / ops-cli: ${OPS_ATTRS}`
);

// C-3
const missing = [...swPaths].filter((p) => !existsSync(join(WEB, 'static', p)));
check(
	'C-3a: every overridable file ships in apps/web/static',
	missing.length === 0,
	missing.join(', ')
);
let brandJsonOk = false;
try {
	const b = JSON.parse(readFileSync(join(WEB, 'static', 'brand', 'brand.json'), 'utf8')) as {
		schema?: unknown;
		name?: unknown;
		beta_badge?: unknown;
	};
	brandJsonOk = b.schema === 1 && b.name === DEFAULT_BRAND_NAME && b.beta_badge === true;
} catch {
	/* reported below */
}
check('C-3b: shipped /brand/brand.json is the default brand with BETA on', brandJsonOk);

// C-4 / C-5 / C-6
type Dict = Record<string, unknown>;
function flatten(d: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
	if (typeof d === 'string') out.set(prefix, d);
	else if (Array.isArray(d)) d.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
	else if (d !== null && typeof d === 'object')
		for (const [k, v] of Object.entries(d as Dict)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
	return out;
}
// The slot builder's own pattern — a form it would not recognise leaves a
// half-marked slot in the prerendered page.
const SLOT_FORM_RE = new RegExp(`^${SLOT_FORM_SOURCE}$`);
const locales = readdirSync(LOCALES)
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.replace(/\.json$/, ''))
	.sort();
const flat = new Map<string, Map<string, string>>();
for (const code of locales) {
	flat.set(code, flatten(JSON.parse(readFileSync(join(LOCALES, `${code}.json`), 'utf8'))));
}
const malformed: string[] = [];
const badForms: string[] = [];
for (const [code, m] of flat) {
	for (const [key, s] of m) {
		const all = s.match(/\{brand[^}]*\}?/g) ?? [];
		const good = s.match(new RegExp(BRAND_PLACEHOLDER_RE.source, 'g')) ?? [];
		if (all.length !== good.length) malformed.push(`${code}:${key}`);
		for (const t of good) {
			const form = /\{brand\|([^}]*)\}/.exec(t)?.[1];
			if (form !== undefined && !SLOT_FORM_RE.test(form))
				badForms.push(`${code}:${key} → "${form}"`);
		}
	}
}
check(
	'C-4a: every {brand…} placeholder is well-formed',
	malformed.length === 0,
	malformed.slice(0, 8).join(', ')
);
check(
	'C-4b: every {brand|form} default form is recognised by the slot builder',
	badForms.length === 0,
	badForms.slice(0, 8).join(', ')
);

const en = flat.get('en')!;
// A key whose English names ONLY the site ({brand}, no literal "Morphit") must
// not name "Morphit" literally in any translation: that mention would stay
// "Morphit" on a re-branded site. (A translation may omit the name entirely —
// "Every order you've posted." — which is fine: there is nothing to re-brand.)
// "Morphi" also catches inflected forms (Polish "w Morphicie").
const LITERAL_RE = /Morphi|مورفیت/;
const siteOnly = [...en]
	.filter(([, s]) => /\{brand/.test(s) && !LITERAL_RE.test(s))
	.map(([k]) => k);
const leaked: string[] = [];
for (const [code, m] of flat) {
	if (code === 'en') continue;
	for (const key of siteOnly) {
		const s = m.get(key);
		if (
			s !== undefined &&
			LITERAL_RE.test(s.replace(new RegExp(BRAND_PLACEHOLDER_RE.source, 'g'), ''))
		)
			leaked.push(`${code}:${key}`);
	}
}
check(
	`C-5: no translation names "Morphit" literally where English names only the site (${siteOnly.length} keys)`,
	leaked.length === 0,
	`${leaked.length} leaked, e.g. ${leaked.slice(0, 6).join(', ')}`
);
check(
	'C-6: /login title is "Sign in to {brand}"',
	[...en].some(([k, s]) => k.endsWith('.title') && s === 'Sign in to {brand}')
);

// C-7
check(
	'C-7a: the SPA shell and the tamper-manifest files are protected from branding',
	[
		'index.html',
		'index.html.br',
		'service-worker.js',
		'_app/immutable/entry/start.js',
		'verify.json'
	].every(isProtectedPath)
);
const pairs: string[] = [];
for (const f of [join(WEB, 'src', 'app.html'), join(WEB, 'static', 'degraded.html')]) {
	const n = (readFileSync(f, 'utf8').match(/&#8288;|\u2060/g) ?? []).length;
	if (n === 0 || n % 2 !== 0) pairs.push(`${f.slice(REPO.length + 1)} has ${n} markers`);
}
check(
	'C-7b: app.html / degraded.html brand-slot markers are paired',
	pairs.length === 0,
	pairs.join('; ')
);

// C-8
const mainSrc = readFileSync(join(REPO, 'apps', 'ops-cli', 'src', 'main.ts'), 'utf8');
const valueFlags = /const VALUE_FLAGS = new Set\(\[([\s\S]*?)\]\);/.exec(mainSrc)?.[1] ?? '';
const needValue = [
	'logo',
	'logo-footer',
	'icon',
	'name',
	'short-name',
	'beta',
	'description',
	'category'
];
const noValue = needValue.filter((f) => !valueFlags.includes(`'${f}'`));
check(
	'C-8: the CLI takes a value after every branding apply flag (and payment-method add --name/--description/--category)',
	noValue.length === 0,
	`missing from VALUE_FLAGS: ${noValue.join(', ')} — "--${noValue[0]} X" would read as "true" and drop X`
);

// C-9
const bwConf = readFileSync(join(REPO, 'ops', 'bunkerweb', 'frontend', 'nginx.conf'), 'utf8');
const bwRe =
	/location ~ (\^\/\(\?:brand\/[^ ]*) \{\n\s*add_header Cache-Control "no-cache" always;/.exec(
		bwConf
	)?.[1];
const uncached = bwRe
	? [...BRAND_OVERRIDABLE_PATHS, '/splash/splash-ipad-10.png'].filter(
			(p) => !new RegExp(bwRe).test(p)
		)
	: ['(no brand no-cache location found)'];
const overCached = bwRe
	? ['/_app/immutable/entry/start.js', '/index.html', '/og-image.png', '/brandish.svg'].filter(
			(p) => new RegExp(bwRe).test(p)
		)
	: [];
check(
	'C-9: the BunkerWeb frontend marks every brand asset no-cache (and nothing else)',
	uncached.length === 0 && overCached.length === 0,
	`not no-cache: ${uncached.join(', ')}; wrongly matched: ${overCached.join(', ')}`
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('✗ branding-contract smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} branding-contract checks passed`);
