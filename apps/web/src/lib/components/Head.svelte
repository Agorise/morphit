<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { currentLocale } from '$i18n';
	import { canonicalFor, hreflangAlternates, CANONICAL_ORIGIN } from '$lib/seo/urls';
	import { computeOnionLocation } from '$lib/seo/onionLocation';
	import { instance } from '$stores/instance';

	interface Props {
		/**
		 * Lookup key under `seo.<key>.title` / `seo.<key>.description` in
		 * every locale file. Required.
		 */
		routeKey: string;
		/**
		 * Optional values to interpolate into the i18n title and
		 * description.  Used for routes whose title needs a dynamic
		 * field (block number, account, trx id, etc.).  Passed
		 * through to svelte-i18n's translator.
		 */
		titleValues?: Record<string, string | number>;
		descriptionValues?: Record<string, string | number>;
		/**
		 * If provided, overrides the path used for canonical + hreflang.
		 * Defaults to `$page.url.pathname`. Useful when a single SvelteKit
		 * route handles multiple conceptual URLs.
		 */
		path?: string;
		/**
		 * Extra JSON-LD objects injected as <script type="application/ld+json">.
		 * Home emits Organization, FAQ emits FAQPage, etc.
		 */
		jsonLd?: unknown[];
		/**
		 * Disable indexing on a per-route basis (defaults to indexable).
		 */
		noindex?: boolean;
	}

	let { routeKey, titleValues, descriptionValues, path, jsonLd, noindex = false }: Props = $props();

	const resolvedPath = $derived(path ?? $page.url.pathname ?? '/');
	const canonical = $derived(canonicalFor(resolvedPath));
	const alternates = $derived(hreflangAlternates(resolvedPath));

	const baseTitle = $derived(
		titleValues
			? ($_(`seo.${routeKey}.title`, { values: titleValues }) as string)
			: $_(`seo.${routeKey}.title`)
	);
	/** Title bar = route-specific title + instance name (when configured).
	 *  E.g.  "Browse offers — alice-morphit" or just "Browse offers" on
	 *  unbranded instances.  Identity-after-context follows the convention
	 *  most operating systems use ("Document.docx — Word"). */
	const title = $derived.by(() => {
		// Per-instance SEO override for the homepage (task #4).
		// Operators set MORPHIT_INSTANCE_SEO_TITLE/_DESCRIPTION/
		// _KEYWORDS to override the bundled i18n defaults without
		// forking the frontend.  Override applies AS-IS (no instance
		// suffix) since operators authoring the override know what
		// they want their full title to read.
		if (routeKey === 'home' && $instance.seo?.title) {
			return $instance.seo.title;
		}
		return $instance.name ? `${baseTitle} — ${$instance.name}` : baseTitle;
	});
	const description = $derived.by(() => {
		if (routeKey === 'home' && $instance.seo?.description) {
			return $instance.seo.description;
		}
		return descriptionValues
			? ($_(`seo.${routeKey}.description`, { values: descriptionValues }) as string)
			: $_(`seo.${routeKey}.description`);
	});
	const siteName = $derived($_('seo.site_name'));

	/** Keywords meta. Optional per route — falls back to empty
	 *  string when the locale doesn't define one, and we skip
	 *  emission rather than emit an empty meta tag. Modern crawlers
	 *  largely ignore <meta name="keywords"> but Yandex, Baidu, and
	 *  some federated indexers still consume it. */
	const keywordsKey = $derived(`seo.${routeKey}.keywords`);
	const keywords = $derived.by(() => {
		// Per-instance SEO override (task #4).
		if (routeKey === 'home' && $instance.seo?.keywords) {
			return $instance.seo.keywords;
		}
		const v = $_(keywordsKey);
		// svelte-i18n returns the key itself when the lookup misses;
		// treat that as "absent."
		return v && v !== keywordsKey ? v : '';
	});

	/** OG image — static asset, 1200x630. The SVG renders into
	 *  `/og-image.svg`; Phase 5 adds a PNG fallback for aggregators
	 *  that don't support SVG OG images (X / Twitter included). */
	const ogImage = `${CANONICAL_ORIGIN}/og-image.svg`;
	const ogImageAlt = $derived($_('seo.og_image_alt'));

	/** Onion-Location meta tag.  When this instance has a Tor
	 *  alt-network address configured AND the current page is NOT
	 *  already on the .onion host, emit the standard Tor-Browser
	 *  meta tag.  Tor Browser auto-detects this and shows a
	 *  ".onion available" pill in its address bar with a one-click
	 *  switch button.
	 *
	 *  Spec: https://community.torproject.org/onion-services/advanced/onion-location/
	 *
	 *  Why a meta tag rather than HTTP header: the canonical Tor
	 *  spec accepts BOTH; meta works regardless of whether the
	 *  operator is behind Cloudflare/Caddy/nginx with custom header
	 *  config.  Operators can ALSO set the header at their reverse
	 *  proxy if they want belt-and-braces; the two paths are
	 *  redundant in a benign way.
	 *
	 *  Mirror destination must be the same path on the .onion host
	 *  so Tor users land on the page they were viewing.  We
	 *  preserve `$page.url.pathname` and search/hash. */
	const onionLocation = $derived(
		computeOnionLocation({
			torAddress: $instance.alt_networks?.tor,
			currentHostname: $page.url.hostname,
			currentPathname: $page.url.pathname,
			currentSearch: $page.url.search,
			currentHash: $page.url.hash
		})
	);
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	{#if keywords}
		<meta name="keywords" content={keywords} />
	{/if}

	{#if noindex}
		<meta name="robots" content="noindex,nofollow" />
	{:else}
		<meta name="robots" content="index,follow,max-image-preview:large" />
	{/if}

	<link rel="canonical" href={canonical} />

	{#if onionLocation}
		<!-- "onion-location" isn't in TypeScript's HTMLMetaElement
		     http-equiv enum but is the canonical value for the Tor
		     Browser onion-redirect spec.  We render via @html so
		     svelte's compile-time attribute checker doesn't reject
		     the non-standard enum value.  The value comes from
		     computeOnionLocation which validates the URL shape, so
		     no XSS surface. -->
		{@html `<meta http-equiv="onion-location" content="${onionLocation.replace(/"/g, '&quot;')}" />`}
	{/if}

	{#each alternates as alt}
		<link rel="alternate" hreflang={alt.hreflang} href={alt.href} />
	{/each}

	<!-- Open Graph -->
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={siteName} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={canonical} />
	<meta property="og:image" content={ogImage} />
	<meta property="og:image:alt" content={ogImageAlt} />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:locale" content={$currentLocale.replace('-', '_')} />

	<!-- Twitter Card -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={ogImage} />
	<meta name="twitter:image:alt" content={ogImageAlt} />

	<!-- JSON-LD (one or more nodes).  The `</script>` in the
	     template literal is split so the svelte-eslint-parser's
	     script-block boundary detector doesn't mis-terminate the
	     surrounding context.  Output is identical at runtime. -->
	{#if jsonLd && jsonLd.length > 0}
		{#each jsonLd as node}
			{@html `<script type="application/ld+json">${JSON.stringify(node).replace(/</g, '\\u003c')}</` +
				`script>`}
		{/each}
	{/if}
</svelte:head>
