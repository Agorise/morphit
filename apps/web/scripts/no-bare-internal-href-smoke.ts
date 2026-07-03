/**
 * Smoke: no-bare-internal-href
 *
 * Guards the per-locale-prerendering invariant (ADR-0024, design doc
 * docs/PER-LOCALE-PRERENDERING-DESIGN.md): EVERY internal `<a href>`
 * absolute path must carry a locale prefix — i.e. be wrapped in
 * `lp(...)` / `localePath(...)`, or already be `/${lang}/...`.
 *
 * Why this matters (cp242): the route tree lives under `[lang]/` with
 * NO `lang` param matcher and NO `reroute` hook. `[lang]/+layout.ts`
 * redirects a non-locale FIRST segment to the prefixed URL — but that
 * only rescues 1-SEGMENT bare paths (`/@account`, `/orderbook`), which
 * match `[lang]/+page` and trigger the redirect. A 2-SEGMENT bare path
 * (`/chat/<peer>`, `/@<account>/<permlink>`, `/inbox/<x>`) matches NO
 * route under `[lang]=<seg1>`, so the redirect never fires → hard 404.
 *
 * cp7 wrapped 88 link sites in `localePath()` and verified "0 bare
 * paths" — but that was a one-time MANUAL check. With no ongoing guard,
 * later edits reintroduced bare hrefs (cp242 found 21 across 8 files,
 * incl. core chat + order-detail links that 404'd). This smoke is that
 * missing guard. It complements `no-bare-path-goto-smoke` (which covers
 * the imperative `goto()` path, not `<a href>`).
 *
 * Detection (two forms):
 *   1. Template:  href={`/...`}      bare unless the path starts `/${`
 *                                    (the explicit `/${lang}/...` form).
 *                                    lp-wrapped hrefs are href={lp(`...`)}
 *                                    — the char after `{` is `l`, not a
 *                                    backtick, so they're never matched.
 *   2. Static:    href="/route..."   bare route-like absolute path.
 *                                    Asset hrefs (with a file extension,
 *                                    e.g. .zip/.xml/.asc — the footer
 *                                    download links, served raw, not via
 *                                    a [lang] route) are exempt.
 *
 * An ALLOWLIST exists for future intentional exceptions (file +
 * substring). It is empty by design — every internal link should be
 * locale-wrapped.
 *
 * Canonical PASS line: `✓ all N internal-href sites checked …` so
 * scripts/run-smokes.sh can tally it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/web/scripts
const SRC = join(HERE, '..', 'src'); // apps/web/src
const BT = String.fromCharCode(96); // backtick, written this way to stay unambiguous in source

/** Intentional exceptions: { file: substring-of-src-relative-path, frag: substring-of-line }.
 *  Empty by design — see file header. */
const ALLOWLIST: ReadonlyArray<{ file: string; frag: string }> = [
	{
		// cp406 — the stats page's "view raw JSON" link points at the indexer
		// API endpoint /v1/stats (same-origin, served by the backend, NOT a
		// localized SvelteKit page). It carries data-sveltekit-reload for a full
		// navigation. Locale-prefixing it (→ /en/v1/stats) would 404; the API
		// lives at /v1/stats for every locale. Intentional, reviewer-confirmed.
		file: 'routes/[lang]/stats/+page.svelte',
		frag: 'href="/v1/stats"'
	}
];

/** Asset file extensions whose static hrefs are served raw (not via a
 *  [lang] route) and so legitimately carry no locale prefix. */
const ASSET_EXT =
	/\.(zip|asc|txt|json|xml|png|svg|jpe?g|webp|gif|avif|ico|webmanifest|pdf|css|m?js|map|woff2?)(\?|$)/i;

function listSvelte(dir: string, out: string[] = []): string[] {
	for (const ent of readdirSync(dir)) {
		const full = join(dir, ent);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (ent === 'node_modules' || ent === '.svelte-kit') continue;
			listSvelte(full, out);
		} else if (ent.endsWith('.svelte')) {
			out.push(full);
		}
	}
	return out;
}

const TEMPLATE_BARE = `href={${BT}/`; // href={`/
const TEMPLATE_PREFIXED = `href={${BT}/$` + '{'; // href={`/${   (the /${lang}/… form)
const STATIC_RE = /href="(\/[^"]*)"/g; // capture static href value

interface Violation {
	file: string;
	line: number;
	snippet: string;
	form: 'template' | 'static';
}

function allowlisted(relFile: string, line: string): boolean {
	return ALLOWLIST.some((a) => relFile.includes(a.file) && line.includes(a.frag));
}

const files = listSvelte(SRC).sort();
const violations: Violation[] = [];
let hrefSites = 0;

for (const file of files) {
	const rel = relative(SRC, file);
	const lines = readFileSync(file, 'utf-8').split('\n');
	lines.forEach((raw, i) => {
		// ── Form 1: bare template-literal href
		if (raw.includes(TEMPLATE_BARE)) {
			hrefSites++;
			if (!raw.includes(TEMPLATE_PREFIXED) && !allowlisted(rel, raw)) {
				violations.push({ file: rel, line: i + 1, snippet: raw.trim(), form: 'template' });
			}
		}
		// ── Form 2: static absolute href(s) on this line
		for (const m of raw.matchAll(STATIC_RE)) {
			const value = m[1]!; // begins with '/'
			// Protocol-relative ("//host") — not an internal route path.
			if (value.startsWith('//')) continue;
			const afterSlash = value.charAt(1);
			// Route-like only: second char is a letter / '@' / digit.
			// Excludes '/', '/#…', '/.well-known', '/?…', etc.
			if (!/[A-Za-z@0-9]/.test(afterSlash)) continue;
			hrefSites++;
			if (ASSET_EXT.test(value)) continue; // raw asset, not a [lang] route
			if (allowlisted(rel, raw)) continue;
			violations.push({ file: rel, line: i + 1, snippet: raw.trim(), form: 'static' });
		}
	});
}

if (violations.length > 0) {
	console.error(
		`✗ no-bare-internal-href: ${violations.length} bare internal href(s) — every internal link MUST be lp()/localePath()-wrapped (a bare 2-segment path 404s; see docs/PER-LOCALE-PRERENDERING-DESIGN.md):\n`
	);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}  [${v.form}]`);
		console.error(`      ${v.snippet}`);
	}
	console.error(
		`\nFix: wrap the path with lp(\`…\`) (component-local \`const lp = $derived((p) => localePath(p, currentLang))\`), or use /\${lang}/… explicitly.`
	);
	process.exit(1);
}

console.log(
	`✓ all ${hrefSites} internal-href sites checked across ${files.length} .svelte files — 0 bare locale-less paths`
);
