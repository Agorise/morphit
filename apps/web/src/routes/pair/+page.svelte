<script lang="ts">
	/**
	 * /pair — `web+morphit:` protocol-handler landing route (cp214).
	 *
	 * `manifest.webmanifest` registers `web+morphit` → `/pair?%s`. When a
	 * `web+morphit:///…` link is opened (the read-only→main-device write-bounce
	 * flow that WriteBlockedReadOnly mints), the OS lands the installed PWA
	 * here with the full protocol URL percent-encoded in the query string.
	 *
	 * This shell mirrors the root `/` redirect shell: prerendered, client-only
	 * (`ssr = false`), no chrome. On mount it:
	 *   1. resolves the payload through `resolveWebMorphitTarget` — a strict,
	 *      allowlisted parser (the security boundary; see resolveTarget.ts),
	 *   2. detects the visitor's locale from `navigator.languages`,
	 *   3. `window.location.replace`s to the same-origin `/<locale><path>`
	 *      target (so it doesn't pollute history and can't redirect off-site).
	 *
	 * A null resolution (unknown/malformed/off-allowlist payload) lands the
	 * user on the locale home page rather than erroring — the same posture as
	 * the root shell's malformed-`?then=` fallback.
	 */

	import { onMount } from 'svelte';
	import { pickLocaleFromAcceptLanguages, localePath } from '$i18n/path';
	import { resolveWebMorphitTarget } from '$lib/pair/resolveTarget';

	onMount(() => {
		const prefs =
			typeof navigator !== 'undefined' && Array.isArray(navigator.languages)
				? Array.from(navigator.languages)
				: [];
		const locale = pickLocaleFromAcceptLanguages(prefs);

		const target = resolveWebMorphitTarget(window.location.search);
		const dest = target
			? localePath(target.pathname, locale) + target.search + target.hash
			: localePath('/', locale);

		window.location.replace(dest);
	});
</script>

<svelte:head>
	<!-- Functional bounce route — never an indexable result. Not in the
	     sitemap; carries noindex like the root `/` shell. -->
	<meta name="robots" content="noindex" />
	<title>Morphit</title>
</svelte:head>

<div style="display: flex; align-items: center; justify-content: center; min-height: 50vh;">
	<p style="color: #666; font-family: system-ui, sans-serif;">Opening Morphit…</p>
</div>
