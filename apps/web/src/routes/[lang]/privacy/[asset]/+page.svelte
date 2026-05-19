<script lang="ts">
	/* Part 122 cp26 — Per-asset privacy guide page.
	 *
	 *  Registry-driven: pulls `privacyFeatures` from the canonical
	 *  asset registry for the URL-param asset, then renders shared
	 *  + asset-specific guidance.  Future asset additions (Dash,
	 *  DOGE, ZEC, ARRR, DCR, SOL, ETH, etc.) get a privacy guide for free by populating
	 *  their `privacyFeatures` field in the registry.
	 *
	 *  URL: `/[lang]/privacy/{asset}` where `{asset}` is the lower-
	 *  case ticker.  Unknown tickers 404 via the load function.
	 *
	 *  Content sources:
	 *    - Asset basics (name, posture) — from registry
	 *    - Fresh-address advice — shared i18n key per advice type
	 *    - Opt-in privacy techs — shared i18n key per tech
	 *    - Common practices — shared content (applies to every asset)
	 *    - "What not to do" — shared content
	 *    - Asset-specific intro + caveats — per-asset i18n
	 *
	 *  Privacy posture: ZERO server-side state.  Page is pure
	 *  static-rendered + client-hydrated.  Reads no user data;
	 *  writes no telemetry. */

	import { page } from '$app/state';
	import { _ } from 'svelte-i18n';
	import { goto } from '$app/navigation';
	import { ASSETS, type AssetTicker } from '@morphit/asset-registry';

	const assetParam = $derived((page.params.asset ?? '').toUpperCase() as AssetTicker);
	const asset = $derived(ASSETS.find((a) => a.ticker === assetParam));

	$effect(() => {
		// Unknown ticker → redirect to /[lang]/privacy index.  The
		// alternative (404) loses the user's locale prefix; redirect
		// preserves it.
		if (asset === undefined) {
			goto(`/${page.params.lang ?? 'en'}/privacy`);
		}
	});

	const guideKey = $derived(asset?.privacyFeatures.privacyGuideKey ?? '');
	const adviceKey = $derived(asset?.privacyFeatures.freshAddressAdvice ?? 'hd-derived');
	const techs = $derived(asset?.privacyFeatures.optInPrivacyTech ?? null);
</script>

<!--
	cp44-J-69 fix: <svelte:head> must NOT live inside any block; Svelte 5
	rejects it as svelte_meta_invalid_placement at compile time.  Pre-cp44
	this was inside the {#if asset} block, which meant the privacy guides
	for BTC/XMR/BLURT/USDT/USDC/DAI/BCH/LTC/DASH/DOGE/ZEC/ARRR/DCR all
	shipped without <title> or <meta description> for that route — SEO
	regression for all 13 asset privacy pages.  Now lifted to the
	component root with conditional content inside the head block.  When
	`asset` is null (unknown asset slug, rare) the {#if asset} below the
	head renders the unknown-asset message in the body; the head still
	emits a sane default title.
-->
<svelte:head>
	{#if asset}
		<title>{$_('privacy.page_title', { values: { asset: asset.ticker } })}</title>
		<meta
			name="description"
			content={$_(`privacy.guides.${guideKey}.meta_description`) as string}
		/>
	{:else}
		<title>{$_('privacy.unknown_asset_title')}</title>
	{/if}
</svelte:head>

{#if asset}
	<article class="mx-auto max-w-3xl px-4 py-8">
		<nav class="mb-4 text-sm">
			<a href={`/${page.params.lang ?? 'en'}/privacy`} class="text-morphit-emerald hover:underline">
				← {$_('privacy.back_to_index')}
			</a>
		</nav>

		<header class="mb-6">
			<div class="flex items-center gap-3">
				<img
					src={`/icons/icon-${asset.ticker.toLowerCase()}.svg`}
					alt=""
					class="h-10 w-10"
					aria-hidden="true"
					loading="lazy"
					decoding="async"
				/>
				<h1 class="text-2xl font-bold">
					{$_('privacy.guide_heading', { values: { asset: asset.ticker } })}
				</h1>
			</div>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_(`privacy.guides.${guideKey}.intro`)}
			</p>
		</header>

		<!-- Fresh-address advice — registry-driven, shared content
		     per advice type (subaddress / hd-derived / account-reuse). -->
		<section class="mb-6">
			<h2 class="mb-2 text-lg font-semibold">
				{$_('privacy.section_fresh_addresses')}
			</h2>
			<p class="text-sm">
				{$_(`privacy.fresh_address_advice.${adviceKey}`)}
			</p>
		</section>

		<!-- Opt-in privacy techs.  Renders one section per tech;
		     each tech has a shared i18n explainer.  Skip the
		     section entirely when the asset has none. -->
		{#if techs !== null && techs.length > 0}
			<section class="mb-6">
				<h2 class="mb-2 text-lg font-semibold">
					{$_('privacy.section_opt_in_tech')}
				</h2>
				<p class="mb-3 text-sm text-ink-600 dark:text-ink-300">
					{$_('privacy.section_opt_in_tech_intro')}
				</p>
				<ul class="space-y-3">
					{#each techs as tech (tech)}
						<li class="rounded-lg border border-ink-200 p-3 dark:border-ink-700">
							<div class="font-semibold text-morphit-emerald">
								{$_(`privacy.opt_in_tech.${tech}.name`)}
							</div>
							<p class="mt-1 text-sm">
								{$_(`privacy.opt_in_tech.${tech}.explain`)}
							</p>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<!-- Common practices — shared across every asset.  Same
		     content for BTC, BCH, LTC, etc., because the principles
		     (fresh address per trade, coin control, don't combine
		     UTXOs from different sources) are universal. -->
		<section class="mb-6">
			<h2 class="mb-2 text-lg font-semibold">
				{$_('privacy.section_common_practices')}
			</h2>
			<div class="space-y-2 text-sm">
				<p>{$_('privacy.common_practices.fresh_per_trade')}</p>
				<p>{$_('privacy.common_practices.coin_control')}</p>
				<p>{$_('privacy.common_practices.network_layer')}</p>
				<p>{$_('privacy.common_practices.kyc_touchpoints')}</p>
			</div>
		</section>

		<!-- What NOT to do — also shared. -->
		<section class="mb-6">
			<h2 class="mb-2 text-lg font-semibold">
				{$_('privacy.section_what_not_to_do')}
			</h2>
			<ul class="list-disc space-y-1 pl-5 text-sm">
				<li>{$_('privacy.what_not_to_do.reuse_address')}</li>
				<li>{$_('privacy.what_not_to_do.exact_amount')}</li>
				<li>{$_('privacy.what_not_to_do.combine_utxos')}</li>
				<li>{$_('privacy.what_not_to_do.clearnet_broadcast')}</li>
			</ul>
		</section>

		<!-- Asset-specific caveats — for assets with structural
		     privacy limits worth flagging (e.g. BLURT being on a
		     fully-public coordination chain). -->
		{#if $_(`privacy.guides.${guideKey}.caveats`) !== `privacy.guides.${guideKey}.caveats`}
			<section
				class="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950"
			>
				<h2 class="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
					⚠ {$_('privacy.section_caveats')}
				</h2>
				<p class="text-sm text-amber-800 dark:text-amber-200">
					{$_(`privacy.guides.${guideKey}.caveats`)}
				</p>
			</section>
		{/if}

		<!-- Closing disclaimer — Morphit doesn't recommend specific
		     wallets.  Reason: even reputable wallets have been
		     hacked or compromised.  Users find their own. -->
		<section
			class="rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
		>
			<p>{$_('privacy.no_wallet_recommendation')}</p>
		</section>
	</article>
{/if}
