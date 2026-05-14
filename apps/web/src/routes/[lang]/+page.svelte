<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import MorphitMark from '$components/MorphitMark.svelte';
	import Tooltip from '$components/Tooltip.svelte';
	import Head from '$components/Head.svelte';
	import FeaturedOrders from '$components/FeaturedOrders.svelte';
	import AltNetworkIcon from '$components/AltNetworkIcon.svelte';
	import { organizationSchema, websiteSchema } from '$seo/jsonld';
	import { instance } from '$stores/instance';

	const points = [
		{ key: 'non_custodial', faq: 'what_is_morphit' as const },
		{ key: 'no_kyc', faq: 'signup_requirements' as const },
		{ key: 'uncensorable', faq: 'who_runs_it' as const },
		{ key: 'grandma', faq: 'is_it_safe' as const }
	];

	// Home page gets the richest JSON-LD: Organization + WebSite (with
	// SearchAction unlocking the SERP sitelinks search box).
	const jsonLd = $derived([
		organizationSchema($_('seo.site_name'), $_('app.tagline')),
		websiteSchema($_('seo.site_name'))
	]);

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<Head routeKey="home" {jsonLd} />

<section class="relative overflow-hidden">
	<!-- Background atmosphere: soft brand gradient wash + subtle grid -->
	<div aria-hidden="true" class="pointer-events-none absolute inset-0 -z-10">
		<div class="absolute inset-0 bg-morphit-gradient-soft"></div>
		<div
			class="absolute inset-0 opacity-[0.035]"
			style="background-image: linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px); background-size: 48px 48px;"
		></div>
	</div>

	<div class="mx-auto max-w-6xl px-4 py-16 md:px-6 md:py-24">
		<div class="flex flex-col items-center text-center">
			<div class="mb-6 animate-fade-up">
				<MorphitMark size={96} animate />
			</div>

			{#if $instance.name}
				<p
					class="animate-fade-up text-sm uppercase tracking-widest text-ink-500 dark:text-ink-400"
					style="animation-delay: 30ms"
				>
					{$_('home.welcome_to_instance', { values: { name: $instance.name } })}
				</p>
				{#if $instance.tagline}
					<p
						class="mt-2 animate-fade-up text-base italic text-ink-600 dark:text-ink-300"
						style="animation-delay: 45ms"
					>
						{$instance.tagline}
					</p>
				{/if}
			{/if}

			<h1
				class="mt-4 animate-fade-up font-display text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl md:text-5xl lg:text-6xl"
				style="animation-delay: 60ms"
			>
				<span class="brand-gradient-text">{$_('home.hero_title')}</span>
			</h1>
			<p
				class="mt-5 max-w-prose animate-fade-up text-lg text-ink-700 dark:text-ink-200"
				style="animation-delay: 140ms"
			>
				{$_('home.hero_body')}
			</p>

			<div
				class="mt-10 flex animate-fade-up flex-wrap items-center justify-center gap-3"
				style="animation-delay: 220ms"
			>
				<a href={lp('/orderbook')} class="btn-primary">{$_('home.cta_browse')}</a>
				<a href={lp('/onboarding')} class="btn-secondary">{$_('home.cta_start')}</a>
			</div>
			<!-- Tertiary CTA for returning users who already have a
			     Blurt account or already used Morphit on another
			     device.  Lower-key than the primary CTAs so first-
			     timers (the larger audience) aren't distracted, but
			     visible enough that returning users don't have to
			     hunt for the top-right corner. -->
			<p
				class="mt-4 animate-fade-up text-sm text-ink-600 dark:text-ink-300"
				style="animation-delay: 280ms"
			>
				{$_('home.returning_user_prompt')}
				<a href={lp('/login')} class="font-semibold text-morphit-emerald hover:underline">
					{$_('home.returning_user_link')}
				</a>
			</p>
		</div>

		<ul class="mt-20 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
			{#each points as point, i (point.key)}
				<li
					class="card animate-fade-up border border-ink-100 dark:border-ink-800"
					style="animation-delay: {300 + i * 90}ms"
				>
					<div class="flex items-start justify-between gap-3">
						<h2 class="font-display text-xl font-bold">
							{$_(`home.points.${point.key}.title`)}
						</h2>
						<Tooltip
							textKey="home.points.{point.key}.body"
							faqKey={point.faq}
							ariaLabel={$_(`home.points.${point.key}.title`)}
						/>
					</div>
					<p class="mt-3 text-ink-600 dark:text-ink-300">{$_(`home.points.${point.key}.body`)}</p>
				</li>
			{/each}
		</ul>

		<!-- Phase 5 item 5: featured slots showcase. Up to 5 orders
		     users have paid to promote. Self-hides when empty so
		     a fresh-install site doesn't show an awkward empty
		     panel. -->
		<div class="mt-16">
			<FeaturedOrders variant="grid" />
		</div>

		<section
			class="mt-20 rounded-3xl border border-ink-100 bg-white p-8 dark:border-ink-800 dark:bg-ink-900 md:p-12"
		>
			<div class="grid gap-8 md:grid-cols-[2fr,3fr]">
				<div>
					<p class="text-xs font-semibold uppercase tracking-widest text-ink-500">
						{$_('home.reachable_via')}
					</p>
					<h3 class="mt-2 font-display text-2xl font-bold">{$_('home.networks_heading')}</h3>
					<p class="mt-3 text-ink-600 dark:text-ink-300">
						{$_('home.networks_body')}
					</p>
				</div>
				<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<div class="flex flex-col items-center gap-2 rounded-2xl bg-ink-50 p-4 dark:bg-ink-800">
						<AltNetworkIcon
							network="tor"
							size={32}
							class="h-8 w-8 text-ink-800 dark:text-ink-100"
						/>
						<span class="text-sm font-semibold">Tor</span>
					</div>
					<div class="flex flex-col items-center gap-2 rounded-2xl bg-ink-50 p-4 dark:bg-ink-800">
						<AltNetworkIcon
							network="lokinet"
							size={32}
							class="h-8 w-8 text-ink-800 dark:text-ink-100"
						/>
						<span class="text-sm font-semibold">Lokinet</span>
					</div>
					<div class="flex flex-col items-center gap-2 rounded-2xl bg-ink-50 p-4 dark:bg-ink-800">
						<AltNetworkIcon
							network="i2p"
							size={32}
							class="h-8 w-8 text-ink-800 dark:text-ink-100"
						/>
						<span class="text-sm font-semibold">I2P</span>
					</div>
					<div class="flex flex-col items-center gap-2 rounded-2xl bg-ink-50 p-4 dark:bg-ink-800">
						<AltNetworkIcon
							network="nostr"
							size={32}
							class="h-8 w-8 text-ink-800 dark:text-ink-100"
						/>
						<span class="text-sm font-semibold">Nostr mirror</span>
					</div>
				</div>
			</div>
		</section>

		<section class="mt-16 grid gap-4 sm:grid-cols-3">
			<div
				class="flex items-center gap-4 rounded-2xl border border-ink-100 bg-white p-5 dark:border-ink-800 dark:bg-ink-900"
			>
				<img src="/icons/icon-btc.svg" alt="Bitcoin" class="h-12 w-12 flex-none" />
				<div>
					<p class="font-display text-lg font-bold">Bitcoin</p>
					<p class="text-sm text-ink-500">{$_('home.asset_subtitles.btc')}</p>
				</div>
			</div>
			<div
				class="flex items-center gap-4 rounded-2xl border border-ink-100 bg-white p-5 dark:border-ink-800 dark:bg-ink-900"
			>
				<img src="/icons/icon-xmr.svg" alt="Monero" class="h-12 w-12 flex-none" />
				<div>
					<p class="font-display text-lg font-bold">Monero</p>
					<p class="text-sm text-ink-500">{$_('home.asset_subtitles.xmr')}</p>
				</div>
			</div>
			<div
				class="flex items-center gap-4 rounded-2xl border border-ink-100 bg-white p-5 dark:border-ink-800 dark:bg-ink-900"
			>
				<img src="/icons/icon-blurt.svg" alt="Blurt" class="h-12 w-12 flex-none" />
				<div>
					<p class="font-display text-lg font-bold">Blurt</p>
					<p class="text-sm text-ink-500">{$_('home.asset_subtitles.blurt')}</p>
				</div>
			</div>
		</section>
	</div>
</section>
