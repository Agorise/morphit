<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { building } from '$app/environment';
	import { currentLocale } from '$i18n';
	import { canonicalFor, hreflangAlternates, ogLocale, ogLocaleAlternates, CANONICAL_ORIGIN } from '$lib/seo/urls';
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
		/**
		 * Optional RSS / Atom feeds for `<link rel="alternate" type="...">`
		 * auto-discovery.  Feed readers (NetNewsWire, Feedly, Inoreader,
		 * etc.) probe HTML <head> for these tags and surface a "subscribe"
		 * affordance when present.  Also a documented SEO signal for
		 * news/blog crawlers.  Pass empty/undefined on pages with no
		 * matching feed.
		 *
		 * **SECURITY CONSTRAINT (cp114):** the `href` field MUST be a
		 * SITE-CONTROLLED URL (literal string or relative path), NEVER
		 * an operator-published or peer-supplied URL.  The href-xss
		 * smoke allowlists `feed.href` on this exact basis; any new
		 * call site that wants to pass operator-/peer-controlled feed
		 * URLs MUST first wrap them through `safeContactUrl()` from
		 * `$lib/utils/safeContactUrl` and update the allowlist comment
		 * to reflect that the constraint has changed.
		 *
		 * Example for the orderbook page:
		 *   feeds={[{ title: 'Morphit orderbook', href: '/rss/orderbook.xml' }]}
		 */
		feeds?: Array<{ title: string; href: string; type?: 'rss' | 'atom' }>;
	}

	let {
		routeKey,
		titleValues,
		descriptionValues,
		path,
		jsonLd,
		noindex = false,
		feeds
	}: Props = $props();

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

	/** OG image (cp112).
	 *
	 *  We emit BOTH the PNG and SVG variants:
	 *    - PNG is the primary `og:image` and `twitter:image`.  Twitter/X,
	 *      LinkedIn, Slack, Discord, and several Mastodon link-preview
	 *      crawlers do not reliably render SVG OG images (Twitter rejects
	 *      SVG outright per their card spec).
	 *    - SVG is emitted as a second `og:image` entry — sharp on
	 *      high-DPI displays for crawlers that DO support it (modern
	 *      Facebook, Pleroma, ActivityPub-aware tooling).
	 *
	 *  Specs followed: 1200×630 (Twitter `summary_large_image` + Facebook
	 *  OG recommended sizes; same canvas for both).  File size 61 KB —
	 *  under Twitter's 5 MB cap by three orders of magnitude. */
	const ogImagePng = `${CANONICAL_ORIGIN}/og-image.png`;
	const ogImageSvg = `${CANONICAL_ORIGIN}/og-image.svg`;
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
	 *  preserve `$page.url.pathname` and search/hash.
	 *
	 *  Part 121 cp7: `url.search` and `url.hash` are forbidden
	 *  during SvelteKit prerender (they're runtime values not
	 *  known at build time).  When `building` is true, we pass
	 *  empty strings — the prerendered HTML carries the
	 *  path-only onion mirror, which is correct for static
	 *  content.  At runtime after hydration, the client-side
	 *  re-render picks up the real search/hash from the URL. */
	const onionLocation = $derived(
		computeOnionLocation({
			torAddress: $instance.alt_networks?.tor,
			currentHostname: $page.url.hostname,
			currentPathname: $page.url.pathname,
			currentSearch: building ? '' : $page.url.search,
			currentHash: building ? '' : $page.url.hash
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

	<!-- RSS / Atom feed auto-discovery (cp112).  Feed readers and
	     some SEO crawlers probe the head for `rel="alternate"
	     type="application/rss+xml"` tags.  Only emitted on pages
	     that pass a `feeds` prop. -->
	{#if feeds && feeds.length > 0}
		{#each feeds as feed}
			<link
				rel="alternate"
				type={feed.type === 'atom' ? 'application/atom+xml' : 'application/rss+xml'}
				title={feed.title}
				href={feed.href}
			/>
		{/each}
	{/if}

	<!-- Open Graph -->
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={siteName} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={canonical} />
	<!-- Primary og:image is PNG (universal compat across X/Twitter,
	     LinkedIn, Slack, Discord, FB).  SVG fallback emitted as a
	     secondary og:image for crawlers that prefer vector.
	     cp119-A6: each og:image is followed by its own og:image:alt
	     so crawlers that pick the SVG (Pleroma, ActivityPub tooling)
	     also receive alt text. -->
	<meta property="og:image" content={ogImagePng} />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content={ogImageAlt} />
	<meta property="og:image" content={ogImageSvg} />
	<meta property="og:image:type" content="image/svg+xml" />
	<meta property="og:image:alt" content={ogImageAlt} />
	<!-- og:locale (cp112 audit A10): emit Facebook-conformant
	     `language_TERRITORY` form via ogLocale() rather than the bare
	     hyphenated locale code, which some scrapers fall back to
	     default-handling for. -->
	<meta property="og:locale" content={ogLocale($currentLocale)} />
	<!-- og:locale:alternate (cp112 audit A11): OG analog of hreflang.
	     Emits one entry per other locale; helps Facebook/LinkedIn
	     pick the right preview when a share lands from a non-default
	     language. -->
	{#each ogLocaleAlternates($currentLocale) as alt}
		<meta property="og:locale:alternate" content={alt} />
	{/each}

	<!-- Twitter Card -->
	<meta name="twitter:card" content="summary_large_image" />
	{#if $instance.seo?.twitter_site}
		<!-- cp119-A4: operator-configured X handle ("@morphit").
		     Twitter cards still render without this; presence adds
		     "via @handle" attribution to the card. -->
		<meta name="twitter:site" content={$instance.seo.twitter_site} />
	{/if}
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={description} />
	<meta name="twitter:image" content={ogImagePng} />
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
