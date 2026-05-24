/**
 * href-xss smoke — guards against unsafe `href={...}` bindings
 * where the bound expression is operator/peer-controlled and
 * could be a `javascript:` / `data:` / `vbscript:` URL that
 * executes in the user's session.
 *
 * Two attack classes this catches:
 *
 * 1. Operator-published `contact_url` and `origin` strings
 *    rendered as `<a href={x}>` without scheme validation.
 *    A malicious operator publishes
 *    `contact_url=javascript:fetch('/?'+document.cookie)`
 *    and every user clicking the link in the footer / instances
 *    list / operators directory runs that JavaScript.
 *
 * 2. Peer-supplied URLs (chat payloads with `address`, `txid`,
 *    `note` fields) interpolated into hrefs.  Lower likelihood
 *    because chat hrefs go through `morphitExplorerTxUrl` /
 *    `externalExplorerUrl` which regex-validate, but new code
 *    sometimes bypasses those builders.
 *
 * Heuristic: any `href={EXPR}` whose EXPR isn't:
 *   - a string literal (`href="/foo"`)
 *   - an interpolation starting with a route literal (`href={`/${x}/y`}`)
 *   - a result of a known-safe builder/helper (morphit*Url, safe*,
 *     valid*, externalExplorerUrl, blurtWalletExplorerFallbackUrl)
 *   - one of the local nav config arrays (link.href, store.url —
 *     allowlisted by site)
 *
 * Allowlist for site-specific safe bindings (e.g., the global nav
 * config that's local to the codebase, not operator-published) is
 * declared as `ALLOWLIST_HREF_EXPR` below — keyed by file path and
 * the EXACT trimmed expression text, not line number, so allowlist
 * entries don't drift with formatting changes.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

const SCAN_DIRS = [
	path.join(REPO_ROOT, 'apps/web/src/routes'),
	path.join(REPO_ROOT, 'apps/web/src/lib/components')
];

const EXCLUDE_PATH_PATTERNS: readonly RegExp[] = [/\/dev\//, /__tests__\//, /\.test\./];

/** Known-safe URL-builder/validator function names whose return
 *  value is verified safe by the helper itself (regex/scheme/etc).
 *  An `href={someBuilder(...)}` expression is OK if it starts with
 *  one of these names. */
const SAFE_BUILDER_NAMES = [
	'morphitExplorerAccountUrl',
	'morphitExplorerTxUrl',
	'morphitExplorerBlockUrl',
	'externalExplorerUrl',
	'blurtWalletExplorerFallbackUrl',
	'safeContactUrl',
	'safeInstanceOrigin',
	'validateContactUrl', // local /operators function returning string|null
	'canonicalFor', // Head.svelte canonical builder
	'shareUrl', // FaqSearch builder
	'explorerLinkForTxid', // ChatMessage builder; calls morphitExplorerTxUrl/externalExplorerUrl internally
	// Part 121 cp7 — per-locale link wrapper.  `lp(path)` calls
	// `localePath(path, currentLang)` from `$i18n/path`.  The
	// `path` argument is always a literal authored by us at the
	// call site (never operator/peer-controlled) and
	// `localePath()` itself returns a `/<lang>/...` path string,
	// never reflecting attacker-controlled values into the href.
	// Code at $i18n/path.ts has 22 smoke scenarios pinning the
	// shape invariants.
	'lp',
	'localePath'
];

/** Per-file allowlist for href bindings the smoke can't prove safe
 *  via the SAFE_BUILDER_NAMES heuristic, but a human reviewer has
 *  confirmed are safe.  Keyed by file path and matched against the
 *  EXACT trimmed expression text inside `href={...}` — line numbers
 *  intentionally NOT used because they drift on every formatting
 *  change (prettier minor-version line-wrap drift, comment edits,
 *  Part-74 validatedX lesson).  Adding an entry here means the
 *  reviewer has confirmed that NO call site in <file> writes the
 *  given <expr> to a value an attacker controls. */
const ALLOWLIST_HREF_EXPR: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	[
		'apps/web/src/routes/[lang]/+layout.svelte',
		// `link.href` — from the `navLinks` array that maps over
		// `[ { href: lp('/orderbook'), ... }, ... ]`.  Each href
		// is constructed via `lp()` (which calls localePath() —
		// already in SAFE_BUILDER_NAMES above) so by the time the
		// template reads `link.href`, the value is a locale-prefixed
		// path string that the smoke can't trace back to lp() but
		// a reviewer has confirmed safe.  See Part 121 cp7 design
		// doc.
		new Set(['link.href'])
	],
	[
		'apps/web/src/lib/components/ToastRegion.svelte',
		// `toast.href` — validated at toast-creation time
		// (apps/web/src/lib/stores/toast.ts: showToast scheme allowlist).
		new Set(['toast.href'])
	],
	[
		'apps/web/src/lib/components/Head.svelte',
		// `canonical` and `alt.href` — computed locally from $page.url,
		// never operator/peer-controlled.  `canonical` is the result of
		// `canonicalFor(resolvedPath)` (a SAFE_BUILDER already, but the
		// smoke's call-detection only fires when the expression starts
		// with `name(`; bare `canonical` looks like a plain identifier).
		// `alt.href` is similar — `alt` is an element of
		// `hreflangAlternates(resolvedPath)`'s output.
		//
		// cp114: `feed.href` allowlisted.  The `feeds` prop on this
		// component is only ever passed from site-controlled call sites
		// (currently /[lang]/+page.svelte and /[lang]/orderbook/+page.svelte,
		// both passing the literal `/rss/orderbook.xml` string).  The prop
		// is documented in the Head.svelte module-doc as taking only
		// site-controlled feed metadata.  Any future call site that passes
		// operator-/peer-published URLs into `feeds` would need to wrap
		// them through `safeContactUrl()` first; this allowlist entry
		// covers only the current site-controlled usage.
		new Set(['canonical', 'alt.href', 'feed.href'])
	],
	[
		'apps/web/src/routes/[lang]/+layout.svelte',
		// `link.href` — local navLinks config in +layout.svelte; not
		// operator/peer-published.
		new Set(['link.href'])
	],
	[
		'apps/web/src/routes/[lang]/download/+page.svelte',
		// `store.url` — local STORES config in /download; site-controlled.
		new Set(['store.url'])
	],
	[
		'apps/web/src/lib/components/WriteBlockedReadOnly.svelte',
		// `deepLink` — computed locally by a $derived.by that hardcodes
		// every branch to a `web+morphit://...` literal (the protocol
		// handler registered in manifest.webmanifest).  The only
		// dynamic substitution is `peer` and `orderPermlink`, both
		// passed in through component props from internal call sites
		// (orderbook, chat, settings, etc.) — never operator-/peer-
		// controlled raw URLs.  Both are URL-encoded via
		// encodeURIComponent before insertion.  See the deepLink
		// $derived block in WriteBlockedReadOnly.svelte for details
		// and the registration in apps/web/static/manifest.webmanifest
		// for the protocol handler scope.
		new Set(['deepLink'])
	],
	[
		'apps/web/src/lib/components/PrioritiesSection.svelte',
		// `faqHref(p.faqKey)` — every faqKey comes from the hardcoded
		// `PRIORITIES` constant inside the component (7 entries, no
		// user/operator/peer input).  `faqHref` itself just calls
		// localePath() (a SAFE_BUILDER) and concatenates a '#' anchor.
		// The smoke can't trace the chain through the wrapper, but a
		// reviewer has confirmed safe.  See PrioritiesSection.svelte
		// module-doc + the PRIORITIES const declaration.
		new Set(['faqHref(p.faqKey)'])
	],
	[
		'apps/web/src/lib/components/ChatMessage.svelte',
		// cp121: `trackingUrl` is one of two values, both site-controlled:
		//   1. buildTrackingUrl(carrierEntry.trackingUrlTemplate, sh.tracking)
		//      — where carrierEntry.trackingUrlTemplate comes from the
		//      hardcoded CARRIERS const in apps/web/src/lib/shipping/carriers.ts.
		//      The carrier-registry-invariants smoke (cp120) enforces that
		//      every template starts with `https://` and contains a single
		//      `{tracking}` placeholder; buildTrackingUrl URL-encodes the
		//      tracking number before substituting.  No operator/peer input
		//      reaches the URL template — only the carrier KEY (validated
		//      against the bundled registry via CARRIERS_LOOKUP).
		//   2. sh.customTrackingUrl — peer-controlled via the chat
		//      payload BUT validated through isValidCustomTrackingUrl()
		//      in apps/web/src/lib/chat/payload.ts, which (a) enforces
		//      starts-with-https://, (b) round-trips through new URL()
		//      to confirm well-formed, and (c) rejects any scheme other
		//      than https: (this rejects javascript:, data:, etc. —
		//      covered by S-8 in shipping-payload-roundtrip-smoke).
		// Both the canonical and custom paths are scheme-locked to https://.
		// Anchor element also carries rel="noopener noreferrer" to suppress
		// referrer leak + Spectre-style window.opener attacks.
		new Set(['trackingUrl'])
	],
	[
		'apps/web/src/routes/[lang]/settings/security/2fa/+page.svelte',
		// `app.officialUrl` — comes from RECOMMENDED_AUTHENTICATOR_APPS,
		// a hardcoded TypeScript constant in
		// `apps/web/src/lib/auth/recommendedAuthenticatorApps.ts` that
		// only Morphit maintainers can edit (not operators, not peers,
		// not users).  Every entry is statically curated under the
		// strict open-source-only policy documented in ADR-0043.  The
		// `2fa-recommended-apps-coverage-smoke` validates that every
		// officialUrl in the list starts with `https://` and is not
		// localhost, providing a second structural check.  Anchor
		// elements also carry rel="noopener noreferrer" to suppress
		// referrer leak + Spectre-style window.opener attacks.
		new Set(['app.officialUrl'])
	]
]);

let scenarios = 0;
let failures = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			yield* walk(full);
		} else if (stat.isFile() && full.endsWith('.svelte')) {
			yield full;
		}
	}
}

interface Hit {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function detectUnsafeHref(absPath: string): readonly Hit[] {
	const src = readFileSync(absPath, 'utf8');
	const hits: Hit[] = [];
	const newlinePositions: number[] = [-1];
	for (let i = 0; i < src.length; i++) {
		if (src[i] === '\n') newlinePositions.push(i);
	}
	function lineOf(offset: number): number {
		let lo = 0,
			hi = newlinePositions.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (newlinePositions[mid] < offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	}

	// Match: `href={EXPR}` where EXPR may itself contain template-
	// literal interpolations like `${foo}` (whose internal `}`
	// would close the outer `{` if we used a naive regex).
	//
	// Walk character-by-character tracking brace depth from the
	// `href={` opener; capture from the inner brace's open until
	// its balanced close.  `${` increments depth, `}` decrements.
	// Backticks aren't relevant — only braces matter for balance.
	function* hrefBindings(src: string): Iterable<{ index: number; expr: string }> {
		const opener = /href=\{/g;
		let m: RegExpExecArray | null;
		while ((m = opener.exec(src)) !== null) {
			const innerStart = m.index + m[0].length;
			let depth = 1;
			let i = innerStart;
			while (i < src.length && depth > 0) {
				const ch = src[i];
				const next = src[i + 1];
				if (ch === '$' && next === '{') {
					depth++;
					i += 2;
					continue;
				}
				if (ch === '{') {
					depth++;
				} else if (ch === '}') {
					depth--;
					if (depth === 0) break;
				}
				i++;
			}
			if (depth === 0) {
				yield { index: m.index, expr: src.slice(innerStart, i) };
			}
		}
	}

	for (const { index, expr: rawExpr } of hrefBindings(src)) {
		const expr = rawExpr.trim();

		// Skip `'#'`, `"#"`, '`#`'
		if (expr === '"#"' || expr === "'#'" || expr === '`#`') continue;

		// Skip string literals starting with `/` or `https://` or `http://`
		// (route literal or absolute URL).
		if (/^['"`]\//.test(expr)) continue;
		if (/^['"`]https?:\/\//.test(expr)) continue;

		// Skip template literals starting with `/` or `${...}/`
		if (/^`\//.test(expr)) continue;
		if (/^`https?:\/\//.test(expr)) continue;
		// Template literals with leading interpolation that points to a
		// known internal path: `${root}/foo` — too permissive to detect
		// without parsing.  Allowlist if needed.

		// Skip known-safe builder calls.  Either at the start of expr
		// or as the leftmost identifier in a `?? '#'` / `|| '#'` chain.
		const leftmostName = expr.match(/^([\w$]+)\s*\(/)?.[1];
		if (leftmostName && SAFE_BUILDER_NAMES.includes(leftmostName)) continue;

		// Skip if expr uses one of the safe-* helpers anywhere as the
		// outer call (handles `safeContactUrl(x)` ?? null patterns).
		// Match any safe* / *Url builder at the head of the expr.
		if (/^\bsafe[A-Z]\w*\b/.test(expr)) continue;
		if (/^\b\w+Url\(/.test(expr)) continue;

		// Skip identifiers (no parens, no operators) whose name starts
		// with `validated` — the project convention is that a
		// `validatedXxx` identifier is the result of an upstream
		// `validateXxxForRender()`-style validator that returns
		// string-or-null.  Same rationale as the safe* prefix
		// recognition below for template literals: lets call sites
		// stay readable without forcing a wrapping function call.
		// Catches: `validatedNostrUrl`, `validatedBlurtMediaUrl`,
		// `validatedContactUrl`, etc.  Part 74.
		if (/^validated[A-Z]\w*$/.test(expr)) continue;

		// Skip template literals whose leading interpolation is a
		// pre-validated `safeXxx`-named identifier.  Pattern:
		// `${safeOther}/@account/permlink` — the safe* prefix is the
		// project's convention for "this value already passed
		// validation."  Allowing this here avoids forcing the
		// alternative pattern (compute the full URL up-front and
		// pass through SAFE_BUILDER_NAMES) every time, which often
		// makes the call site less readable.  The smoke catches a
		// real regression if a `${operatorOrigin}/...` (no safe-
		// prefix) form ever lands.
		// Part 70: extend to recognize this convention.
		if (/^`\$\{\s*safe[A-Z]\w*\s*\}/.test(expr)) continue;

		// Skip `BUILDER(...) ?? FALLBACK` and `BUILDER(...) || FALLBACK`
		// patterns where BUILDER is one of the SAFE_BUILDER_NAMES and
		// FALLBACK is a string literal (commonly `'#'`).
		// Example: `href={explorerLinkForTxid(p.method, p.txid) ?? '#'}`.
		// The builder returns string|null; null falls to the literal,
		// which is safe.
		const safeFallbackRe = new RegExp(
			`^(${SAFE_BUILDER_NAMES.join('|')})\\s*\\([^)]*\\)\\s*(?:\\?\\?|\\|\\|)\\s*['"\`][^'"\`]*['"\`]\\s*$`
		);
		if (safeFallbackRe.test(expr)) continue;

		// Skip ternaries where BOTH branches are string literals.
		// Example: `href={isExternal ? 'https://...' : '/internal'}`.
		// Both are static; safe.
		const bothLiteralTernaryRe = /^[^?]+\?\s*['"`][^'"`]*['"`]\s*:\s*['"`][^'"`]*['"`]\s*$/;
		if (bothLiteralTernaryRe.test(expr)) continue;

		const lineNum = lineOf(index);
		const relPath = path.relative(REPO_ROOT, absPath);
		const allowedExprs = ALLOWLIST_HREF_EXPR.get(relPath);
		if (allowedExprs && allowedExprs.has(expr)) continue;

		const preview = `href={${expr}}`.slice(0, 120);
		hits.push({ file: relPath, line: lineNum, text: preview });
	}
	return hits;
}

console.log('\n── href-xss smoke ────────────────────────────────────────\n');

scenario('apps/web/src/routes + lib/components: no operator-controlled raw href', () => {
	const allHits: Hit[] = [];
	for (const dir of SCAN_DIRS) {
		for (const file of walk(dir)) {
			const rel = path.relative(REPO_ROOT, file);
			if (EXCLUDE_PATH_PATTERNS.some((rx) => rx.test(rel))) continue;
			allHits.push(...detectUnsafeHref(file));
		}
	}
	if (allHits.length > 0) {
		const sample = allHits
			.map((h) => `\n    ${h.file}:${h.line}: ${JSON.stringify(h.text)}`)
			.join('');
		throw new Error(
			`found ${allHits.length} potentially-unsafe href binding(s).  ` +
				'Wrap operator/peer-controlled URLs in `safeContactUrl()` or ' +
				'`safeInstanceOrigin()` from `$lib/utils/safeContactUrl`.  ' +
				'For confirmed-safe site-controlled URLs, add an entry to ' +
				'the `ALLOWLIST_HREF_EXPR` map in this smoke (keyed by file ' +
				'path → set of exact expression strings, e.g. `link.href`). ' +
				`Hits:${sample}`
		);
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
