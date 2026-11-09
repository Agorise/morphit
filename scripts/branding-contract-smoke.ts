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
 *     network-first so a re-brand reaches returning visitors at once);
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
 *        default brand (and, since v1.21.5, has no BETA marker field).
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
 *   C-10 (v1.23.5) The brandable app shell: the build's spa-shell.html carries
 *        the preview picture after app.html's static preview tags, ops-cli
 *        does not protect it, and both nginx configs answer `/` and the app's
 *        routes with it before index.html.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_OVERRIDABLE_PATHS } from '../apps/web/src/lib/net/dynamicPaths.ts';
import { SPA_SHELL } from '../apps/ops-cli/src/lib/nginxVhostHeal.ts';
import {
	BRAND_TARGETS,
	PNG_ICONS,
	CANONICAL_HTML_ATTRS as OPS_ATTRS,
	isProtectedPath
} from '../apps/ops-cli/src/lib/branding.ts';
import {
	CANONICAL_HTML_ATTRS as BUILD_ATTRS,
	SLOT_FORM_SOURCE,
	processPage,
	spaShellText,
	SPA_SHELL_FILE
} from './build-brand-slots.mjs';
import { brandPage } from '../apps/ops-cli/src/lib/branding.ts';
import { deriveTheme, themeStyleElement } from '../packages/operator-config/src/theme.ts';
import { stripMarkedOrigins } from '../apps/web/scripts/origin-slots.mjs';
import { shellMatchesIndex } from '../apps/web/src/lib/net/shellIntegrity.ts';
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
	brandJsonOk = b.schema === 1 && b.name === DEFAULT_BRAND_NAME && !('beta_badge' in b);
} catch {
	/* reported below */
}
check('C-3b: shipped /brand/brand.json is the default brand (no BETA marker)', brandJsonOk);

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
	'logo-size',
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

// C-10 (v1.23.5): the brandable app shell. The build writes spa-shell.html —
// index.html with the link-preview picture right after app.html's static
// preview tags — and nginx answers `/` and the app's routes with it.
const appHtml = readFileSync(join(WEB, 'src', 'app.html'), 'utf8');
const shellText = spaShellText(appHtml, 'https://morphit.io');
const pic = shellText.indexOf(
	'<meta property="og:image" content="\u2063https://morphit.io\u2063/og-image.png" />'
);
const desc = shellText.indexOf('<meta name="twitter:description"');
check(
	'C-10a: the shell copy puts the preview picture (origin-marked, alt brand-marked) after the static preview tags',
	pic > desc &&
		desc > 0 &&
		shellText.includes('og:image:alt" content="&#8288;Morphit&#8288; —') &&
		shellText.includes(
			'<meta name="twitter:image" content="\u2063https://morphit.io\u2063/og-image.png" />'
		) &&
		spaShellText(appHtml, null) === appHtml,
	`picture at ${pic}, twitter:description at ${desc}`
);
check(
	'C-10b: the shell copy is the same file name in the build, the bare-metal heal and both nginx configs, and is not protected',
	SPA_SHELL_FILE === SPA_SHELL && !isProtectedPath(SPA_SHELL_FILE),
	`${SPA_SHELL_FILE} vs ${SPA_SHELL}`
);
const shellConf: string[] = [];
for (const f of [
	join('ops', 'bunkerweb', 'frontend', 'nginx.conf'),
	join('ops', 'nginx', 'web.conf')
]) {
	const c = readFileSync(join(REPO, f), 'utf8');
	if (!/location @spa \{\n\s*try_files \/spa-shell\.html \/index\.html =503;/.test(c))
		shellConf.push(`${f}: @spa does not try spa-shell.html, then index.html`);
	if (!/location \/ \{[^}]*\n\s*try_files \$uri \$uri\.html @spa;/.test(c))
		shellConf.push(`${f}: \`location /\` does not hand \`/\` to @spa`);
}
check(
	'C-10c: nginx answers `/` and the app routes with spa-shell.html, falling back to index.html',
	shellConf.length === 0,
	shellConf.join('; ')
);

// C-10d (v1.23.5): what branding writes into the shell copy is what the
// browser's build-integrity check allows (shellIntegrity.ts) — else every
// branded site would show its visitors "Build integrity check failed". The
// real steps on app.html: the shell copy, the origin and brand markers taken
// out, the slots branded with a name, a colour theme and the site's address.
{
	const page = appHtml
		.replaceAll('%sveltekit.assets%', '')
		.replace(
			'%sveltekit.head%',
			'<link rel="modulepreload" href="/_app/immutable/entry/start.A.js" />'
		)
		.replace(
			'%sveltekit.body%',
			'<script>{ __sveltekit_a = { base: "" }; import("/_app/immutable/entry/start.A.js") }</script>'
		)
		.replace(/%sveltekit\.[a-z.]+%/g, '');
	const index = processPage(stripMarkedOrigins(page).text, { stamp: false }).text as string;
	const shell = processPage(stripMarkedOrigins(spaShellText(page, 'https://morphit.io')).text, {
		stamp: true
	}) as {
		text: string;
		slots: [number, number, string, string][];
		theme: [number, number, string, string][];
	};
	const theme = deriveTheme({ from: '#f3dca0', to: '#bb872f' });
	const branded =
		theme.ok &&
		brandPage(
			shell.text,
			[...shell.slots, ...shell.theme].sort((a, b) => a[0] - b[0]) as Parameters<
				typeof brandPage
			>[1],
			'Vigilante Trading',
			{ style: themeStyleElement(theme.palette), color: theme.palette.tokens['brand-2']! }
		).replaceAll('https://morphit.io/og-image.png', 'https://vigilante.trading/og-image.png');
	const ok =
		typeof branded === 'string' &&
		branded !== index &&
		branded.includes('Vigilante Trading') &&
		branded.includes('id="morphit-theme"') &&
		shellMatchesIndex(index, branded) &&
		!shellMatchesIndex(index, branded.replace('</body>', '<script src="/x.js"></script></body>'));
	check(
		'C-10d: a shell copy branded with a name, a colour theme and an address passes the browser integrity check (and a tampered one does not)',
		ok,
		theme.ok ? 'the branded copy fails shellMatchesIndex' : 'theme did not derive'
	);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('✗ branding-contract smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} branding-contract checks passed`);
