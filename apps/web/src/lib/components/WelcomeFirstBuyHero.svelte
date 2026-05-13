<script lang="ts">
	/**
	 * WelcomeFirstBuyHero — celebratory + explanatory banner for new
	 * users with the free-first-buy waiver still available.
	 *
	 * Renders ONLY when:
	 *   - user is logged in (has a Blurt account)
	 *   - waiver eligibility check returned 'eligible' or
	 *     'eligible_unknown_account'
	 *   - user hasn't dismissed the banner this session
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

	const DISMISS_KEY = 'morphit.welcomeFirstBuyHero.dismissed';

	type Phase = 'loading' | 'show' | 'hide';
	let phase = $state<Phase>('loading');

	const live = $derived($liveIdentity);

	onMount(async () => {
		if (!live) {
			phase = 'hide';
			return;
		}
		// Per-session dismiss — the banner reappears after a fresh
		// page load if not dismissed mid-session.  We don't persist
		// to localStorage because the natural end-state (the user
		// completes the buy → waiver consumed → banner stops
		// showing because eligibility flips false) is the right
		// dismissal mechanism.  Persistent dismiss would risk
		// hiding the banner from someone who sat on it for a week.
		try {
			if (sessionStorage.getItem(DISMISS_KEY) === '1') {
				phase = 'hide';
				return;
			}
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

	function dismiss(): void {
		try {
			sessionStorage.setItem(DISMISS_KEY, '1');
		} catch {
			// no-op
		}
		phase = 'hide';
	}
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
					<p class="mt-2 text-sm text-ink-700 dark:text-ink-200">
						{$_('welcome_first_buy.lead')}
					</p>
				</div>
			</div>
			<button
				type="button"
				class="flex-none rounded-md p-1 text-ink-500 hover:text-ink-700 dark:text-ink-400 dark:hover:text-ink-200"
				onclick={dismiss}
				aria-label={$_('welcome_first_buy.dismiss_aria') as string}
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
					<path d="M18 6 6 18" />
					<path d="m6 6 12 12" />
				</svg>
			</button>
		</div>

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
			<a href="/post?welcome=1" class="btn-primary inline-flex items-center gap-2">
				<span aria-hidden="true">🌱</span>
				<span>{$_('welcome_first_buy.cta_compose')}</span>
			</a>
			<a
				href="/faq#first_order_free"
				class="text-sm font-semibold text-morphit-emerald hover:underline"
			>
				{$_('welcome_first_buy.learn_more')}
			</a>
		</div>
	</section>
{/if}
