<script lang="ts">
	import '../../app.css';
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { afterNavigate } from '$app/navigation';
	import LanguageSwitcher from '$components/LanguageSwitcher.svelte';
	import RssFeedPicker from '$components/RssFeedPicker.svelte';
	import UpdateBanner from '$components/UpdateBanner.svelte';
	import StaleBuildBanner from '$components/StaleBuildBanner.svelte';
	import TamperAlertBanner from '$components/TamperAlertBanner.svelte';
	import OperatorBlockBanner from '$components/OperatorBlockBanner.svelte';
	import AltNetworkIcon from '$components/AltNetworkIcon.svelte';
	import AvatarMenu from '$components/AvatarMenu.svelte';
	import MorphitLogoBling from '$components/MorphitLogoBling.svelte';
	import PermissionBanner from '$components/PermissionBanner.svelte';
	import SeedBackupNudge from '$components/SeedBackupNudge.svelte';
	import PairedReadOnlyBanner from '$components/PairedReadOnlyBanner.svelte';
	import ToastRegion from '$components/ToastRegion.svelte';
	import { startAmbientChannels } from '$lib/notifications/ambient';
	import { bannerTriggered, clearBannerTrigger } from '$lib/notifications/native';
	import { isUnlocked, lockSession } from '$stores/identity';
	import { startAutoLockTimer } from '$stores/autoLock';
	import { instance, initInstance } from '$stores/instance';
	import { resetForRoute as resetGlossarySeen } from '$stores/glossarySeen';
	import { safeContactUrl } from '$lib/utils/safeContactUrl';
	import { initChainFee } from '$stores/chainFee';
	import { initRelease } from '$stores/release';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import {
		startTradeEventListener,
		stopTradeEventListener,
		refreshTradeEventListener
	} from '$lib/trades/tradeEventListener';
	import { crossPageTradeEventsEnabled } from '$lib/notifications/crossPageTradeEvents';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { currentLocale } from '$i18n';

	interface Props {
		children: import('svelte').Snippet;
	}
	let { children }: Props = $props();

	// Part 121 cp7 — local helper that always wraps a path with
	// the current page's locale prefix.  Falls back to
	// DEFAULT_LOCALE when $page.data.lang is missing (defensive;
	// shouldn't happen under the [lang]/+layout.ts load() but
	// covers the brief window between route mount and load
	// resolve).  Used by every internal anchor and navigation
	// site in the nav/header/footer; see also: the deferred
	// internal-link audit in REVISIT-LIST §A for the sweep of
	// per-page link sites still using bare hrefs.
	// Drive the locale prefix from the active-locale STORE, not
	// $page.data.lang.  The two are equal on every real navigation (the
	// [lang] load sets both), but the store ALSO updates on an in-place
	// locale swap (LanguageSwitcher's onboarding path, which uses
	// replaceState instead of navigating).  Reading the store keeps the
	// header nav links in sync during that swap; it's render-correct under
	// SSR/prerender because the layout load runs initI18nFor(code) before
	// render, so $currentLocale already equals the route locale.
	const currentLang = $derived($currentLocale);
	const lp = $derived((path: string) => localePath(path, currentLang));

	// Tier-N a11y deferred from Part 100 — route-transition focus
	// management.  SvelteKit's default doesn't move focus on
	// client-side navigation, which is a documented SPA a11y
	// issue: a screen-reader user who navigates from /faq to
	// /orderbook hears nothing about the page change because
	// focus stayed on whatever they activated.  After every
	// successful navigation, move focus to the <main> region.
	// Screen readers announce "main, region" on focus, giving
	// the user an audible breadcrumb that the page changed.
	//
	// Why <main> and not the page's <h1>: focusing a heading is
	// the textbook ideal but requires every route to expose a
	// stable id on its h1, which is invasive across 30+ routes.
	// The <main> approach gives 90% of the value at near-zero
	// cost — the user hears the landmark, then arrow-keys or
	// Tab from there.  An afterNavigate hook running on EVERY
	// nav (including hash changes within a page) would be
	// noisy; we restrict to actual route changes by checking
	// `from?.url.pathname !== to?.url.pathname`.
	//
	// `tabindex="-1"` on <main> below makes it programmatically
	// focusable without putting it in the Tab order — keyboard
	// users still tab through the skip-link → header → page
	// content sequence as they did before.
	let mainEl = $state<HTMLElement | null>(null);

	afterNavigate((nav) => {
		if (!mainEl) return;
		// Skip the first page load (no `from`) and same-page
		// hash changes — those don't represent a route change.
		if (!nav.from) return;
		if (nav.from.url.pathname === nav.to?.url.pathname) return;
		// Ensure focus actually lands.  queueMicrotask so the
		// DOM has settled after the route swap.
		queueMicrotask(() => mainEl?.focus());
	});

	// Start the ambient notification channels (title-bar prefix,
	// favicon canvas badge, App Badging API) on mount. These are
	// zero-permission channels that update in the user's peripheral
	// vision whenever unreadCount changes. See
	// docs/NOTIFICATIONS-DESIGN.md and apps/web/src/lib/notifications/.
	onMount(() => {
		startAmbientChannels();
		// Fetch this instance's branding once.  The store will
		// re-render any subscribed component when the response
		// arrives (or stays at fallback if the fetch fails).
		void initInstance();
		// Phase G prep / task #10 — fetch the chain's current
		// account_creation_fee.  Renders in FAQ entries, signup
		// helpers, and anywhere else we'd otherwise hardcode
		// "100 BLURT".  Indexer caches 24h; we cache for the
		// session.
		void initChainFee();
		// Batch J — release-trust-anchor verification.  Fetches
		// the latest signed release op from chain (NOT via
		// indexer; indexer trust would be circular here),
		// verifies @morphit's posting pubkey on chain matches our
		// pinned constant, validates the payload, and runs a
		// SHA-256 check on the running bundle's assets against
		// the signed manifest.  Surfaces stale-build banner +
		// tamper-alert banner if either check fails.  Silent on
		// chain-RPC unreachable (no positive evidence).
		void initRelease();
	});

	// Auto-lock idle timer. Starts when the user becomes unlocked;
	// Reset the per-route glossary-tooltip seen-set whenever
	// the route changes, so the "first appearance per page"
	// rule for `<Term>` underlines applies fresh per page.
	// Cheap effect — Set construction + one comparison; runs
	// only on actual pathname change (resetForRoute is a no-op
	// when the pathname matches).
	$effect(() => {
		resetGlossarySeen($page.url.pathname);
	});

	// Auto-lock: starts when the user becomes unlocked,
	// stops when they lock or sign out. On timeout (default 9 hours
	// of idle, configurable), fires lockSession() which clears
	// in-memory keys but preserves the persisted keystore. Uses
	// $effect so the teardown runs when isUnlocked flips to false
	// OR when the component unmounts.
	$effect(() => {
		if (!$isUnlocked) return;
		const stop = startAutoLockTimer(() => {
			lockSession();
		});
		return stop;
	});

	// Phase F.5 — Global trade-event listener.  Opens chat SSE
	// streams for all recent peers when the user is unlocked, so
	// trade-status updates flow into the tradeStatus store
	// regardless of which page the user is on.  Cross-page toasts
	// fire from this listener; /my/orders badges read from the
	// store reactively.
	//
	// Same lifecycle as auto-lock: start on unlock, teardown on
	// lock.  Self-suppressing if no blurt account on file.
	//
	// Phase F.5 audit fix (F-23) — also gated by user opt-in
	// preference.  Privacy-conscious users can disable the
	// listener entirely (no ambient decryption); chat-page service
	// still handles trade events when the user is on /chat/<peer>.
	$effect(() => {
		if (!$isUnlocked) {
			stopTradeEventListener();
			return;
		}
		if (!$crossPageTradeEventsEnabled) {
			stopTradeEventListener();
			return;
		}
		const account = getUserBlurtAccount();
		if (account === null) return;
		startTradeEventListener(account);

		// Phase F.5 audit fix (F-29) — pick up new peers as the
		// user starts new conversations.  Without this hook, the
		// listener's stream set is frozen at startup and only
		// updated by the next lock/unlock cycle.
		const onRecentPeersChanged = (): void => refreshTradeEventListener();
		if (typeof window !== 'undefined') {
			window.addEventListener('morphit:recent-peers-changed', onRecentPeersChanged);
		}

		return () => {
			if (typeof window !== 'undefined') {
				window.removeEventListener('morphit:recent-peers-changed', onRecentPeersChanged);
			}
			stopTradeEventListener();
		};
	});

	const navLinks = $derived([
		{ href: lp('/orderbook'), key: 'nav.orderbook' },
		{ href: lp('/faq'), key: 'nav.faq' },
		{ href: lp('/chat'), key: 'nav.messages' },
		{ href: lp('/post'), key: 'nav.post_now' }
	]);

	function isActive(href: string): boolean {
		// Part 121 cp7 — both `href` and `path` now carry the
		// locale prefix (e.g. /de/orderbook), so the existing
		// startsWith test still works.  Old comment preserved
		// for the no-prefix design: the test was startsWith
		// rather than equal so /faq highlighted for both /faq
		// and /faq#fees.
		const path = $page.url.pathname;
		return path.startsWith(href);
	}
</script>

<div class="flex min-h-[100dvh] flex-col">
	<!-- Skip link for keyboard users -->
	<a
		href="#main"
		class="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-morphit-btn focus:px-4 focus:py-2 focus:text-white"
	>
		{$_('a11y.skip_to_content')}
	</a>

	<header
		class="sticky top-0 z-40 border-b border-ink-100 bg-white/80 backdrop-blur-md dark:border-ink-800 dark:bg-ink-950/80"
	>
		<div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 md:px-6">
			<!-- Wide wordmark logo, hyperlinked to the locale home.  MUST be
			     locale-prefixed (`lp('/')` → e.g. `/en`), NOT a bare `/`:
			     a bare `/` leaves the [lang] subtree for the root
			     detection-redirect shell, which redirects via
			     `window.location.replace` — a FULL PAGE RELOAD that drops
			     the in-memory identity session (a "Remember me" keystore is
			     encrypted-at-rest, so a hard reload lands the user locked).
			     Keeping the logo inside [lang] makes it a client-side nav,
			     exactly like the primary nav links, so it preserves the
			     session.  `shine` enables a subtle occasional glint
			     (every ~15s) tracing the wordmark — pure CSS, masked to the
			     wordmark shape, removed under prefers-reduced-motion.  (The
			     hero logo on the homepage uses the same component WITHOUT
			     `shine`, so it stays completely static.) -->
			<a
				href={lp('/')}
				class="flex items-center rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
				aria-label="Morphit — home"
			>
				<MorphitLogoBling heightPx={32} shine />
			</a>

			<nav aria-label="Primary" class="hidden gap-1 md:flex">
				{#each navLinks as link (link.href)}
					<a
						href={link.href}
						class="rounded-xl px-4 py-2 font-medium transition hover:bg-ink-100 dark:hover:bg-ink-800 {isActive(
							link.href
						)
							? 'text-morphit-emerald'
							: 'text-ink-700 dark:text-ink-200'}"
						aria-current={isActive(link.href) ? 'page' : undefined}
					>
						{$_(link.key)}
					</a>
				{/each}
			</nav>

			<div class="flex items-center gap-2">
				<LanguageSwitcher />
				<!--
					AvatarMenu renders either:
					- Signed in: avatar identicon with unread-count badge
					  overlay + dropdown containing the notifications
					  fly-out, My orders, Settings, and Sign out.
					- Signed out: the "Sign in / Register" CTA button.
				-->
				<AvatarMenu />
			</div>
		</div>

		<!-- Mobile nav -->
		<nav aria-label="Mobile" class="border-t border-ink-100 dark:border-ink-800 md:hidden">
			<div class="mx-auto flex max-w-7xl items-center justify-around px-2 py-1">
				{#each navLinks as link (link.href)}
					<a
						href={link.href}
						class="flex-1 rounded-lg px-3 py-2 text-center text-sm font-medium {isActive(link.href)
							? 'text-morphit-emerald'
							: 'text-ink-600 dark:text-ink-300'}"
						aria-current={isActive(link.href) ? 'page' : undefined}
					>
						{$_(link.key)}
					</a>
				{/each}
				<!-- No sign-in link here on purpose. The AvatarMenu in the
				     header is visible on mobile too (no md:hidden) and already
				     renders the "Sign in / Register" CTA when signed out — a
				     mobile-nav link as well showed the same label twice (the
				     bright button top-right PLUS a text link right under it).
				     The header AvatarMenu is the single canonical entry point;
				     the primary navLinks above (Orderbook, FAQ, Messages, Post
				     now) stay the same signed-in or signed-out. -->
			</div>
		</nav>
	</header>

	<!-- Paired-readonly persistent banner.  Visible only when the
	     current session was established via QR-pair from a phone
	     (ADR-0022) — keeps the user aware that this device can
	     READ everything but can't BROADCAST anything; signing
	     happens on the phone. -->
	<PairedReadOnlyBanner />

	{#if $bannerTriggered}
		<PermissionBanner category={$bannerTriggered.category} onClose={clearBannerTrigger} />
	{/if}

	<!-- Seed-backup nudge.  Self-rendering: appears only when the
	     user has had a persisted keystore for 7+ days without
	     dismissing.  See $lib/crypto/persistentKeystore for the
	     localStorage anchors. -->
	<SeedBackupNudge />

	<main bind:this={mainEl} id="main" tabindex="-1" class="flex-1 focus:outline-none">
		{@render children()}
	</main>

	<footer class="mt-16 border-t border-ink-100 bg-ink-50 py-10 dark:border-ink-800 dark:bg-ink-950">
		<div class="mx-auto flex max-w-7xl flex-col items-center gap-6 px-4 text-center md:px-6">
			<!-- Footer brand: full wide wordmark only. Small mark + "Morphit" text removed.
			     Lazy-loaded per Priority #4 — footer is below-the-fold on every page;
			     never in LCP candidate set. -->
			<img
				src="/brand/morphit-wordmark.svg"
				alt="Morphit"
				loading="lazy"
				decoding="async"
				class="animate-morphit-hue-shift h-10 w-auto"
			/>

			<p class="text-sm text-ink-600 dark:text-ink-400">{$_('footer.tagline')}</p>

			{#if $instance.name}
				{@const safeContact = safeContactUrl($instance.contact_url)}
				<p class="text-sm text-ink-500 dark:text-ink-400">
					{$_('footer.operated_by')}
					{#if safeContact}
						<a
							href={safeContact}
							class="font-medium text-morphit-emerald hover:underline"
							title={$_('footer.contact_operator')}
							target="_blank" rel="noopener noreferrer"
						>
							{$instance.name}
						</a>
					{:else}
						<span class="font-medium text-ink-700 dark:text-ink-200">{$instance.name}</span>
					{/if}
				</p>
			{/if}

			<div class="flex flex-col items-center gap-3">
				<p class="text-xs uppercase tracking-widest text-ink-500">{$_('footer.reachable_via')}</p>
				<ul class="flex flex-wrap justify-center gap-2">
					<li>
						{#if $instance.alt_networks.tor}
							<a
								href="http://{$instance.alt_networks.tor}"
								class="chip"
								title={$_('footer.alt_network_address', {
									values: { address: $instance.alt_networks.tor }
								})}
								rel="noopener noreferrer"
								target="_blank"
							>
								<AltNetworkIcon
									network="tor"
									size={20}
									class="h-5 w-5 text-ink-800 dark:text-ink-100"
								/>
								{$_('footer.tor')}
							</a>
						{:else}
							<span
								class="chip cursor-not-allowed opacity-50"
								title={$_('footer.alt_network_disabled')}
								aria-disabled="true"
							>
								<AltNetworkIcon
									network="tor"
									size={20}
									class="h-5 w-5 text-ink-800 dark:text-ink-100"
								/>
								{$_('footer.tor')}
							</span>
						{/if}
					</li>
					<li>
						{#if $instance.alt_networks.lokinet}
							<a
								href="http://{$instance.alt_networks.lokinet}"
								class="chip"
								title={$_('footer.alt_network_address', {
									values: { address: $instance.alt_networks.lokinet }
								})}
								rel="noopener noreferrer"
								target="_blank"
							>
								<AltNetworkIcon
									network="lokinet"
									size={20}
									class="h-5 w-5 text-ink-800 dark:text-ink-100"
								/>
								{$_('footer.lokinet')}
							</a>
						{:else}
							<span
								class="chip cursor-not-allowed opacity-50"
								title={$_('footer.alt_network_disabled')}
								aria-disabled="true"
							>
								<AltNetworkIcon
									network="lokinet"
									size={20}
									class="h-5 w-5 text-ink-800 dark:text-ink-100"
								/>
								{$_('footer.lokinet')}
							</span>
						{/if}
					</li>
					<li>
						{#if $instance.alt_networks.i2p_b32}
							<a
								href="http://{$instance.alt_networks.i2p_b32}"
								class="chip"
								title={$_('footer.alt_network_address', {
									values: { address: $instance.alt_networks.i2p_b32 }
								})}
								rel="noopener noreferrer"
								target="_blank"
							>
								<AltNetworkIcon
									network="i2p"
									size={20}
									class="h-5 w-5 text-ink-800 dark:text-ink-100"
								/>
								{$_('footer.i2p_b32')}
							</a>
						{:else}
							<span
								class="chip cursor-not-allowed opacity-50"
								title={$_('footer.alt_network_disabled')}
								aria-disabled="true"
							>
								<AltNetworkIcon
									network="i2p"
									size={20}
									class="h-5 w-5 text-ink-800 dark:text-ink-100"
								/>
								{$_('footer.i2p_b32')}
							</span>
						{/if}
					</li>
					{#if $instance.alt_networks.i2p_name}
						<li>
							<a
								href="http://{$instance.alt_networks.i2p_name}"
								class="chip"
								title={$_('footer.alt_network_address', {
									values: { address: $instance.alt_networks.i2p_name }
								})}
								rel="noopener noreferrer"
								target="_blank"
							>
								<AltNetworkIcon
									network="i2p"
									size={20}
									class="h-5 w-5 text-ink-800 dark:text-ink-100"
								/>
								{$_('footer.i2p_name')}
							</a>
						</li>
					{/if}
					<li>
						{#if $instance.alt_networks.nostr}
							<a
								href="nostr:{$instance.alt_networks.nostr}"
								class="chip"
								title={$_('footer.alt_network_address', {
									values: { address: $instance.alt_networks.nostr }
								})}
								rel="noopener noreferrer"
								target="_blank"
							>
								<AltNetworkIcon
									network="nostr"
									size={20}
									class="h-5 w-5 text-ink-800 dark:text-ink-100"
								/>
								{$_('footer.nostr')}
							</a>
						{:else}
							<span
								class="chip cursor-not-allowed opacity-50"
								title={$_('footer.alt_network_disabled')}
								aria-disabled="true"
							>
								<AltNetworkIcon
									network="nostr"
									size={20}
									class="h-5 w-5 text-ink-800 dark:text-ink-100"
								/>
								{$_('footer.nostr')}
							</span>
						{/if}
					</li>
					<!--
						No-JS pill. Previously intended as `?nojs=1` — a server-side
						hydration-suppression switch. The site is prerendered + hydrated
						today, which means disabling JS in the browser already yields the
						same outcome (the static HTML is emitted regardless); a per-request
						switch needs a Phase 5 architectural change (per-request SSR). The
						pill links to the FAQ entry that explains this so the link is
						informative rather than broken.
					-->
					<li>
						<a href={lp('/faq#no_js_limits')} title={$_('footer.no_js_title')} class="chip">
							<svg
								class="h-4 w-4"
								viewBox="0 0 24 24"
								xmlns="http://www.w3.org/2000/svg"
								aria-hidden="true"
							>
								<rect x="1.5" y="1.5" width="21" height="21" rx="3" fill="#F7DF1E" />
								<text
									x="12"
									y="17"
									text-anchor="middle"
									font-family="system-ui,sans-serif"
									font-size="10"
									font-weight="900"
									fill="#000">JS</text
								>
								<circle cx="12" cy="12" r="10" fill="none" stroke="#DC2626" stroke-width="2.2" />
								<line
									x1="5"
									y1="19"
									x2="19"
									y2="5"
									stroke="#DC2626"
									stroke-width="2.2"
									stroke-linecap="round"
								/>
							</svg>
							{$_('footer.no_js')}
						</a>
					</li>
					<!--
						RSS pill: full orderbook feed. The indexer serves
						/rss/orderbook.xml (and the per-asset / per-account
						feeds under /rss/orderbook/*). Operators following the
						canonical loopback-proxy topology must add an nginx
						`location /rss/` block proxying to the indexer — see
						OPERATIONS.md §14 for the proxy template and §24 for
						the RSS-specific routing. Without that block, this
						link 404s.
						Privacy tradeoff documented in FAQ entry `rss_feeds`.
					-->
					<li>
						<RssFeedPicker
							base="/rss/orderbook"
							label={$_('footer.rss_title')}
							text={$_('footer.rss')}
							triggerClass="chip"
							iconClass="h-4 w-4"
						/>
					</li>
				</ul>
			</div>

			<nav aria-label="Footer" class="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm">
				<a href={lp('/faq')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('nav.faq')}</a
				>
				<a href={lp('/glossary')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('nav.glossary')}</a
				>
				<a href={lp('/cheat-sheet')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('nav.cheat_sheet')}</a
				>
				<a href={lp('/explorer')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('footer.explorer')}</a
				>
				<a href={lp('/download')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('footer.download')}</a
				>
				<a
					href="https://git.agorise.net/agorise/morphit"
					class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					target="_blank" rel="noopener noreferrer">{$_('footer.source')}</a
				>
				<a
					href="/morphit-mediakit.zip" data-sveltekit-reload
					class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					title={$_('footer.mediakit_title')}
					rel="noopener">{$_('footer.mediakit')}</a
				>
				<a href={lp('/operators')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('footer.operators')}</a
				>
				<a href={lp('/instances')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('footer.instances')}</a
				>
				<a href={lp('/security')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('footer.security')}</a
				>
				<a href={lp('/plan')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('footer.plan')}</a
				>
				<a href={lp('/privacy-terms')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('nav.privacy_terms')}</a
				>
				<a
					href="/canary.txt" data-sveltekit-reload
					class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					title={$_('footer.canary_title')}
					rel="noopener">{$_('footer.canary')}</a
				>
				<a
					href="/pgp_keys.asc" data-sveltekit-reload
					class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					title={$_('footer.pgp_keys_title')}
					rel="noopener">{$_('footer.pgp_keys')}</a
				>
				<a href={lp('/security#bounty')} class="text-ink-600 hover:text-morphit-emerald dark:text-ink-300"
					>{$_('footer.bounty')}</a
				>
			</nav>

			<p class="text-xs text-ink-500">AGPL-3.0 · No cookies · No analytics · No logs</p>
		</div>
	</footer>

	<UpdateBanner />
	<StaleBuildBanner />
	<TamperAlertBanner />
	<OperatorBlockBanner />
	<ToastRegion />
</div>
