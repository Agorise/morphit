<script lang="ts">
	/**
	 * Root +page.svelte — detection-redirect shell.
	 *
	 * Part 121 cp7 (per-locale prerendering, ADR-0024, design doc
	 * docs/PER-LOCALE-PRERENDERING-DESIGN.md Option C §4).
	 *
	 * First visit (no locale prefix in URL) lands here.  The shell
	 * picks the best-matching SUPPORTED_LOCALE from
	 * navigator.languages and redirects with window.location.replace
	 * so the bare URL doesn't pollute browser history.
	 *
	 * No content is rendered — the visible body is the spinner-y
	 * "Loading…" placeholder for the ~50ms before redirect fires,
	 * plus a `<noscript>` fallback that meta-refreshes to /en/ for
	 * JS-disabled clients.
	 *
	 * The detection uses `pickLocaleFromAcceptLanguages()` from
	 * `$i18n/path` — a pure module with zero svelte-i18n runtime
	 * dependency, so this shell stays small.
	 *
	 * Why `replace()` not `assign()`: the bare `/` shell should
	 * NOT appear in browser history.  A user hitting back-button
	 * from `/es/orderbook` should land on whatever they were
	 * doing before Morphit, not bounce through the redirect shell
	 * every time.
	 *
	 * cp156 F-mcp-7 — `?then=/path` query-parameter support.
	 *
	 * The MCP server (cp140) needs to hand AI agents URLs they can
	 * pass to users, but the agent doesn't know the user's locale.
	 * Before cp156, the only options were (a) hardcode `/en/` and
	 * accept that non-English users get the English page, or (b)
	 * make every tool call accept a locale parameter (places the
	 * burden on every AI agent integrator).  Neither was good.
	 *
	 * With cp156, the MCP server can hand out `${base}/?then=/path`
	 * deeplinks.  The user clicks → this shell detects their
	 * locale → redirects to `/{detected-lang}{then-value}`.  One
	 * extra hop, but the user's actual locale is preserved.
	 *
	 * Safety: `then` is constrained to start with `/` and not
	 * `//` (which would be a protocol-relative URL escape) and
	 * not contain `\` (Windows-path-like normalization).
	 * Malformed `then` values silently fall back to the root
	 * locale page rather than aborting (a malformed deeplink is
	 * better as a "you landed on Morphit's homepage" experience
	 * than as a stuck loading spinner).
	 */

	import { onMount } from 'svelte';
	import {
		pickLocaleFromAcceptLanguages,
		localePath
	} from '$i18n/path';

	onMount(() => {
		// `navigator.languages` is ordered by preference; the picker
		// walks it via matchSupported() and returns the first
		// supported locale.  Falls back to DEFAULT_LOCALE (`en`)
		// when no match.
		const prefs =
			typeof navigator !== 'undefined' && Array.isArray(navigator.languages)
				? Array.from(navigator.languages)
				: [];
		const preferred = pickLocaleFromAcceptLanguages(prefs);

		// cp156 F-mcp-7 — extract `?then=/path` if present.
		//
		// Safety constraints:
		//   - MUST start with `/` (absolute path only)
		//   - MUST NOT start with `//` (protocol-relative URL escape)
		//   - MUST NOT contain `\` (Windows-path-like normalization
		//     that some browsers fold into `/`)
		//
		// Malformed values silently fall back to root locale page.
		// Rationale: a typoed/malicious deeplink yielding a clean
		// "you landed on Morphit's homepage" experience is better
		// than a hard error.  The deeplink-receiver also can't
		// meaningfully recover from "this URL is bad" — pushing
		// them to root is the most useful fallback.
		const params = new URLSearchParams(window.location.search);
		const thenRaw = params.get('then');
		const thenIsSafe =
			thenRaw !== null &&
			thenRaw.length > 0 &&
			thenRaw.startsWith('/') &&
			!thenRaw.startsWith('//') &&
			!thenRaw.includes('\\');

		let target: string;
		if (thenIsSafe) {
			// `then` value is the full path-with-query the caller
			// wants the user to land on (locale-less).  Prefix the
			// detected locale and use it as the redirect target.
			// We deliberately DROP outer query and hash here — the
			// `then` value carries everything the caller wanted to
			// preserve.
			target = `/${preferred}${thenRaw}`;
		} else {
			// Original behavior: bare root → /{lang} with outer query
			// and hash passed through.  Used when no `?then=` (or
			// when `then` was malformed and we silently dropped it).
			target =
				localePath(window.location.pathname, preferred) +
				window.location.search +
				window.location.hash;
		}

		window.location.replace(target);
	});
</script>

<svelte:head>
	<!-- noscript fallback — JS-disabled clients meta-refresh to
	     English.  We can't detect their locale without JS, so
	     defaulting to the source language is the least-surprising
	     behavior (vs picking a random non-English locale or
	     refusing to navigate). -->
	<noscript>
		<meta http-equiv="refresh" content="0; url=/en" />
	</noscript>
	<!-- The shell itself is intentionally unindexable — search
	     engines should index `/<lang>/` URLs, not the bare /.
	     The [lang] subtree emits its own canonical/hreflang tags
	     per page in its +layout.svelte. -->
	<meta name="robots" content="noindex" />
	<title>Morphit</title>
</svelte:head>

<!-- Minimal visible content — the redirect happens within ~one
     animation frame on a warm cache, so the user typically sees
     this for a flash if at all.  Plain text rather than i18n
     because we haven't loaded a locale bundle yet (and loading
     one would defeat the no-FOUC purpose of the [lang] subtree). -->
<div style="display: flex; align-items: center; justify-content: center; min-height: 50vh;">
	<p style="color: #666; font-family: system-ui, sans-serif;">Loading…</p>
</div>
