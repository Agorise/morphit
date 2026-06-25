<script lang="ts">
	/* Part 122 cp26 — Privacy guide index.  Lists every tradable
	 *  asset with a one-line summary + link to its per-asset
	 *  privacy guide.  Registry-driven; new assets light up
	 *  automatically.
	 *
	 *  This page is intentionally short — the deep content lives
	 *  in the per-asset guides.  Surface here is a navigation
	 *  hub + the cross-asset framing ("here's why this matters
	 *  even for transparent chains").
	 *
	 *  cp112: converted from bare <svelte:head> to the full <Head />
	 *  component so canonical URL, hreflang alternates, OG / Twitter
	 *  cards, robots, and onion-location are emitted alongside the
	 *  title + description.  Adds BreadcrumbList JSON-LD for SERP
	 *  breadcrumb display ("morphit.io › privacy"). */
	import { page } from '$app/stores';
	import { _ } from 'svelte-i18n';
	import { ASSETS } from '@morphit/asset-registry';
	import Head from '$components/Head.svelte';
	import { breadcrumbListSchema } from '$seo/jsonld';
	import { localizedUrl } from '$seo/urls';
	import type { LocaleCode } from '$i18n/locales';

	const lang = $derived($page.params.lang ?? 'en');
	const tradable = $derived(ASSETS.filter((a) => a.canBeTraded));

	/** BreadcrumbList for SERP breadcrumb display.  Two items: site
	 *  root → privacy index.  Asset-specific subpages render their
	 *  own three-item crumb chain. */
	const jsonLd = $derived([
		breadcrumbListSchema([
			{ name: $_('seo.site_name'), url: localizedUrl(lang as LocaleCode, '/') },
			{ name: $_('privacy.index_heading'), url: localizedUrl(lang as LocaleCode, '/privacy') }
		])
	]);
</script>

<Head routeKey="privacy_index" {jsonLd} />

<article class="mx-auto max-w-3xl px-4 py-8">
	<header class="mb-6">
		<h1 class="text-2xl font-bold">{$_('privacy.index_heading')}</h1>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('privacy.index_intro')}
		</p>
	</header>

	<ul class="space-y-3">
		{#each tradable as asset (asset.ticker)}
			<li>
				<a
					href={`/${lang}/privacy/${asset.ticker.toLowerCase()}`}
					class="flex items-start gap-3 rounded-lg border border-ink-200 p-3 transition hover:border-morphit-emerald hover:bg-morphit-emerald/5 dark:border-ink-700"
				>
					<img
						src={`/icons/icon-${asset.ticker.toLowerCase()}.svg`}
						alt=""
						class="h-8 w-8 flex-none"
						aria-hidden="true"
						loading="lazy"
						decoding="async"
					/>
					<div class="flex-1">
						<div class="font-semibold">{asset.ticker}</div>
						<div class="text-sm text-ink-600 dark:text-ink-300">
							{$_(`privacy.guides.${asset.privacyFeatures.privacyGuideKey}.one_line`)}
						</div>
					</div>
					<span class="text-morphit-emerald rtl:inline-block rtl:-scale-x-100" aria-hidden="true">⇨</span>
				</a>
			</li>
		{/each}
	</ul>

	<section
		class="mt-6 rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
	>
		<p>{$_('privacy.no_wallet_recommendation')}</p>
	</section>
</article>
