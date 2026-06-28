<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * WelcomeFirstBuyHero — celebratory + explanatory banner for new
	 * users with the free-first-buy waiver still available.
	 *
	 * Renders ONLY when:
	 *   - user is logged in (has a Blurt account)
	 *   - waiver eligibility check returned 'eligible' or
	 *     'eligible_unknown_account' (so it stops showing once the
	 *     user has any order — i.e. by/at their first completed trade)
	 *
	 * The ✕ no longer dismisses the card — it rolls it up (the ＋ then
	 * re-expands it), and the rolled-up state persists for the session.
	 *
	 * The banner explains the why-BLURT-first design positively:
	 *   1. Free — Morphit covers the listing fee for this one
	 *   2. You'll receive 500+ BLURT (~$1) into your wallet
	 *   3. That BLURT lets you post ~8 future listings, vote on
	 *      Blurt social content, and earns BP loyalty rewards
	 *   4. You also unlock your 1 BP welcome stake the moment your
	 *      first BLURT-paid listing fee fires (which this trade's
	 *      counterparty's feedback will trigger)
	 *
	 * Frame: this isn't a hoop to jump through, it's the most
	 * generous onboarding bonus in P2P crypto. The user is GETTING
	 * something, not paying a tax.
	 *
	 * The CTA opens /post pre-filled for a 500-BLURT-min buy.
	 *
	 * Q10 + user-feedback follow-up — landed on /orderbook so new
	 * users see the welcome the moment they finish signup (the
	 * register-name page redirects to /orderbook).
	 */

	import { _ } from 'svelte-i18n';
	import { onMount } from 'svelte';
	import { liveIdentity } from '$stores/identity';
	import { getUserBlurtAccount } from '$blurt/ops/profile';
	import { checkWaiverEligibility } from '$lib/orders/listingFee';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';

	const COLLAPSE_KEY = 'morphit.welcomeFirstBuyHero.collapsed';

	type Phase = 'loading' | 'show' | 'hide';
	let phase = $state<Phase>('loading');
	// Collapsed = the user rolled the card up via the ✕→＋ toggle. The card
	// stays PRESENT (heading + ＋ to re-expand) — it is NOT dismissed. Persisted
	// per session so a reload keeps it rolled up. The card disappears for good
	// only once the free-first-buy waiver is consumed (checkWaiverEligibility
	// flips to ineligible once the user has any order — i.e. well before/at
	// their first completed trade).
	let collapsed = $state(false);

	const live = $derived($liveIdentity);

	onMount(async () => {
		if (!live) {
			phase = 'hide';
			return;
		}
		// Restore the collapsed (rolled-up) state for this session. We do
		// NOT early-return hidden here: the ✕ no longer dismisses the card,
		// it only rolls it up (＋ re-expands). The card stops showing for good
		// when the free-first-buy waiver is consumed (eligibility flips).
		try {
			collapsed = sessionStorage.getItem(COLLAPSE_KEY) === '1';
		} catch {
			// Private/Incognito mode may throw; fall through.
		}
		const account = getUserBlurtAccount();
		if (!account) {
			phase = 'hide';
			return;
		}
		try {
			const origin = resolveOrigin(MORPHIT_INDEXER_ORIGIN);
			const result = await checkWaiverEligibility(origin, account);
			if (result.kind === 'eligible' || result.kind === 'eligible_unknown_account') {
				phase = 'show';
			} else {
				phase = 'hide';
			}
		} catch {
			phase = 'hide';
		}
	});

	function toggleCollapse(): void {
		collapsed = !collapsed;
		try {
			if (collapsed) sessionStorage.setItem(COLLAPSE_KEY, '1');
			else sessionStorage.removeItem(COLLAPSE_KEY);
		} catch {
			// no-op
		}
	}

	// Part 121 cp7 — per-locale internal-link wrapper.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

{#if phase === 'show'}
	<section
		class="card mb-6 animate-fade-up overflow-hidden border-morphit-emerald/40 bg-gradient-to-br from-morphit-emerald/10 via-transparent to-morphit-emerald/5 p-6"
		aria-labelledby="welcome-first-buy-heading"
	>
		<div class="flex items-start justify-between gap-3">
			<div class="flex items-start gap-4">
				<div
					class="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-morphit-emerald/15 text-3xl"
					aria-hidden="true"
				>
					🎁
				</div>
				<div class="flex-1">
					<h2
						id="welcome-first-buy-heading"
						class="font-display text-xl font-bold text-morphit-emerald"
					>
						{$_('welcome_first_buy.heading')}
					</h2>
					{#if !collapsed}
						<p class="mt-2 text-sm text-ink-700 dark:text-ink-200">
							{$_('welcome_first_buy.lead')}
						</p>
					{/if}
				</div>
			</div>
			<button
				type="button"
				class="flex-none rounded-md p-1 text-ink-500 hover:text-ink-700 dark:text-ink-400 dark:hover:text-ink-200"
				onclick={toggleCollapse}
				aria-expanded={!collapsed}
				aria-controls="welcome-first-buy-body"
				aria-label={(collapsed
					? $_('welcome_first_buy.expand_aria')
					: $_('welcome_first_buy.collapse_aria')) as string}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					{#if collapsed}
						<!-- ＋ : rolled up, click to re-expand -->
						<path d="M12 5v14" />
						<path d="M5 12h14" />
					{:else}
						<!-- ✕ : expanded, click to roll up -->
						<path d="M18 6 6 18" />
						<path d="m6 6 12 12" />
					{/if}
				</svg>
			</button>
		</div>

		{#if !collapsed}
			<div id="welcome-first-buy-body">
				<ul class="mt-5 grid gap-3 text-sm sm:grid-cols-2">
					<li class="flex items-start gap-2">
						<span class="mt-0.5 flex-none text-morphit-emerald" aria-hidden="true">✓</span>
						<span class="text-ink-700 dark:text-ink-200">
							{@html $_('welcome_first_buy.bullet_free')}
						</span>
					</li>
					<li class="flex items-start gap-2">
						<span class="mt-0.5 flex-none text-morphit-emerald" aria-hidden="true">✓</span>
						<span class="text-ink-700 dark:text-ink-200">
							{@html $_('welcome_first_buy.bullet_starter')}
						</span>
					</li>
					<li class="flex items-start gap-2">
						<span class="mt-0.5 flex-none text-morphit-emerald" aria-hidden="true">✓</span>
						<span class="text-ink-700 dark:text-ink-200">
							{@html $_('welcome_first_buy.bullet_runway')}
						</span>
					</li>
					<li class="flex items-start gap-2">
						<span class="mt-0.5 flex-none text-morphit-emerald" aria-hidden="true">✓</span>
						<span class="text-ink-700 dark:text-ink-200">
							{@html $_('welcome_first_buy.bullet_bp_stake')}
						</span>
					</li>
				</ul>

				<p class="mt-5 text-sm text-ink-600 dark:text-ink-300">
					{$_('welcome_first_buy.why_blurt_minimum')}
				</p>

				<div class="mt-5 flex flex-wrap items-center gap-3">
					<a href={lp('/post?welcome=1')} class="btn-primary inline-flex items-center gap-2">
						<span aria-hidden="true">🌱</span>
						<span>{$_('welcome_first_buy.cta_compose')}</span>
					</a>
					<a
						href={lp('/faq#first_order_free')}
						class="text-sm font-semibold text-morphit-emerald hover:underline"
					>
						{$_('common.learn_more')}
					</a>
				</div>
			</div>
		{/if}
	</section>
{/if}
