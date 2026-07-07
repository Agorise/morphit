<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { _ } from 'svelte-i18n';
	import MorphitLogoBling from '$components/MorphitLogoBling.svelte';
	import Head from '$components/Head.svelte';
	// cp169 byte-budget — everything below the fold is lazy-loaded.
	// On a 1024×768 desktop the hero block ends at ~760px (py-24 +
	// 64px wordmark (MorphitLogoBling) + H1 + hero body +
	// CTAs + py-24 bottom), placing the FeaturedOrders wrapper at
	// ~824px — below the 768px fold.  PrioritiesSection sits after
	// FeaturedOrders (or after its empty wrapper on fresh-install
	// instances) so it's also below the fold.  CoinCarousel is
	// further below.  All three lazy-load at the route level so the
	// initial bundle for first-paint is hero-only.
	//
	// cp168 had eager-loaded PrioritiesSection on the theory that it
	// might sit above the fold post-Reachable-via-removal — but
	// measurement showed it doesn't, so cp169 reverts to lazy.
	// AltNetworkIcon import remains removed (Reachable-via panel is
	// gone; the footer renders its own chips).
	import { organizationSchema, websiteSchema, softwareApplicationSchema } from '$seo/jsonld';
	import { instance } from '$stores/instance';
	import { hasAnySession } from '$stores/identity';
	import { hasPersistedKeystore } from '$crypto/persistentKeystore';

	// cp115-cp6: the old 4-card `points` grid (non_custodial / no_kyc /
	// uncensorable / grandma) was deleted — replaced by the 7-card
	// PrioritiesSection which covers the same user-facing properties +
	// 3 more, with FAQ deep-links and hover/click affordances.

	// Part 121 cp7 — per-locale internal-link wrapper.  See
	// $i18n/path.localePath() + the analogous helper in
	// [lang]/+layout.svelte for design rationale.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));

	// Hide the "Start trading" onboarding CTA for anyone who already has
	// an account on this device — whether signed in (unlocked OR
	// paired-readonly) or merely locked (keystore persisted, awaiting
	// unlock). Existing users reach their session via the header
	// AvatarMenu / the Unlock screen; routing them through fresh
	// onboarding makes no sense.
	//
	// hasPersistedKeystore() is NOT reactive and reads false on SSR (no
	// localStorage). $hasAnySession is *also* false for a LOCKED session,
	// so a pure `$hasAnySession || hasPersistedKeystore()` derived can keep
	// the SSR "false" and never re-read on the client — leaving the CTA
	// visible for a locked returning user (the REVISIT-LIST deferred
	// hardening). So mirror the keystore flag into reactive $state via an
	// $effect that re-reads on mount AND whenever the session state flips:
	// mount catches the locked-on-load case; the $hasAnySession dependency
	// catches unlock and sign-out (so the CTA correctly REappears after a
	// sign-out that happens while sitting on the homepage).
	let keystorePersisted = $state(false);
	$effect(() => {
		void $hasAnySession;
		keystorePersisted = hasPersistedKeystore();
	});
	const hideStartTradingCta = $derived($hasAnySession || keystorePersisted);

	// cp169 lazy-loaders for every below-the-fold component on the
	// landing page.  All three sit below the fold on the typical
	// 1024×768 desktop viewport and on every mobile viewport.
	const loadFeaturedOrders = () =>
		import('$components/FeaturedOrders.svelte').then((m) => m.default);
	const loadPrioritiesSection = () =>
		import('$components/PrioritiesSection.svelte').then((m) => m.default);
	const loadCoinCarousel = () =>
		import('$components/CoinCarousel.svelte').then((m) => m.default);

	// Home page gets the richest JSON-LD: Organization + WebSite (with
	// SearchAction unlocking the SERP sitelinks search box).
	// cp119-A5: pass currentLang so each schema emits `inLanguage` —
	// helps Google disambiguate translated copies of the same @id node.
	const jsonLd = $derived([
		organizationSchema($_('seo.site_name'), $_('app.tagline'), currentLang),
		websiteSchema($_('seo.site_name'), currentLang),
		// cp112: SoftwareApplication schema makes the homepage eligible
		// for Google's installation-rich-result UI (price/category/OS).
		// Per-instance SEO description override is respected here so
		// community operators with custom branding get the right copy.
		softwareApplicationSchema(
			$instance.seo?.title || $_('seo.site_name'),
			$instance.seo?.description || ($_('seo.home.description') as string),
			currentLang
		)
	]);

</script>

<Head
	routeKey="home"
	{jsonLd}
	feeds={[
		{ title: $_('seo.site_name') + ' — orderbook (RSS)', href: '/rss/orderbook.xml' },
		{ title: $_('seo.site_name') + ' — orderbook (Atom)', href: '/rss/orderbook.atom', type: 'atom' },
		{
			title: $_('seo.site_name') + ' — orderbook (JSON Feed)',
			href: '/rss/orderbook.json',
			type: 'json'
		}
	]}
/>

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
				<MorphitLogoBling heightClass="h-11 sm:h-16 md:h-20 lg:h-24" shine />
			</div>

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
				{#if !hideStartTradingCta}
					<a href={lp('/onboarding')} class="btn-secondary">{$_('home.cta_start')}</a>
				{/if}
			</div>
			<!-- cp168 removed the returning-user "Already have a Blurt
			     account…" tertiary CTA.  Reason: it mentioned the chain
			     by name above the fold, which we're trying to lessen.
			     Returning users find Sign in via the header AvatarMenu
			     (always visible), and the login flow has its own
			     prompts; this paragraph wasn't load-bearing. -->
		</div>

		<!-- Phase 5 item 5: featured slots showcase — the orders users have
		     paid to promote (up to max_slots, currently 3), each rendered with
		     the shared OrderCard in its featured frame. Self-hides when empty so
		     a fresh-install site doesn't show an awkward empty panel. cp169
		     lazy-loaded — see rationale on the loadFeaturedOrders import.
		     cp431 — `stack` (full-width horizontal cards), identical to the
		     orderbook's featured list, on desktop AND mobile.  The old `grid`
		     variant squished a lone order into a fraction-width portrait cell. -->
		<div class="mt-16">
			{#await loadFeaturedOrders() then FeaturedOrders}
				<FeaturedOrders variant="stack" />
			{/await}
		</div>

		<!-- cp168 removed the "Reachable via" four-network card panel
		     that used to sit here.  Reason: redundant with the footer
		     which already chips Tor / Lokinet / I2P (.b32.i2p) / Nostr
		     + No-JS + RSS.  Removing it shortens the path between the
		     hero and the priorities cards. -->

		<!-- Seven cards bragging about Morphit's design priorities,
		     each hyperlinked to a cross-linked FAQ entry.  Replaces
		     the old 4-card points grid as the canonical priorities
		     surface on the home page.  cp169 lazy-loaded (reverted
		     from cp168 eager — measurement showed it sits below the
		     fold on 1024×768 desktops). -->
		{#await loadPrioritiesSection() then PrioritiesSection}
			<PrioritiesSection />
		{/await}

		<!-- Below-the-fold: carousel of supported assets + 5 settlement
		     networks + barter, lazy-mounted via IntersectionObserver,
		     lazy-loaded images. -->
		{#await loadCoinCarousel() then CoinCarousel}
			<CoinCarousel />
		{/await}
	</div>
</section>
