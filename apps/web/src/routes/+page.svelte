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

		// Build the target URL.  `pathname` for the bare root is
		// `/`; localePath('/', 'es') returns `/es` per the cp6
		// helper's canonical-no-trailing-slash root normalization.
		const target =
			localePath(window.location.pathname, preferred) +
			window.location.search +
			window.location.hash;

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
