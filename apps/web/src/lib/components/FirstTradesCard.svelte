<script lang="ts">
	/**
	 * FirstTradesCard — the homepage's invitation to sign in and make a first
	 * few trades (v1.21.5; replaces the "Run your own Morphit site" card, whose
	 * place is the footer and /run-a-node). v1.21.6: six numbered, floating
	 * tiles (get in, post a buy, private chat, welcome coins, passive income,
	 * loyalty rewards); the homepage mounts it only when it scrolls near.
	 *
	 * Branded sites: every colour is a theme token (src/theme.css), so an
	 * operator's `morphit-ops branding apply` colours re-tint the whole card,
	 * glow and border included.
	 *
	 * Truth: the free first buy, the welcome coins and the loyalty rewards are
	 * paid by this site's relay (RewardsPanel's sources: apps/relay
	 * handlers/order.ts — the free first buy; handlers/feedback.ts — the
	 * 10 + 10 first-trade bonus; the loyalty delegations). A site without an
	 * operator tag pays none of them, so there those two tiles are left out,
	 * the "post a buy" tile does not say "free", and the rest are renumbered.
	 * The passive-income rate is the chain's own: the staking APR computed from
	 * the dynamic global properties ($blurt/apr, as the wallet shows it), read
	 * through this site's indexer (the relay account's balance route carries
	 * them); until it arrives, or if it cannot be read, the tile names no rate.
	 *
	 * Motion: a slow rotating light on the border, two drifting glows and the
	 * tiles' gentle float — CSS only (no JavaScript animation loop), and all of
	 * it stops for `prefers-reduced-motion: reduce`.
	 */
	import { page } from '$app/stores';
	import { _ } from 'svelte-i18n';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	import { instance } from '$stores/instance';
	import { hasAnySession } from '$stores/identity';
	import { hasPersistedKeystore } from '$crypto/persistentKeystore';
	import { fetchAccountBalance } from '$blurt/accountBalance';
	import { computeBlurtVestingApr, formatApr } from '$blurt/apr';
	import { resolveOrigin, MORPHIT_INDEXER_ORIGIN } from '$net/config';

	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));

	/** Rewards are paid by the relay of a site with an operator tag (RewardsPanel). */
	const paysRewards = $derived($instance.loaded && $instance.operator_tag !== null);

	// Someone with an account on this device (signed in, or locked) is sent to
	// trade, not to sign up — the same rule as the hero's "Start trading".
	let keystorePersisted = $state(false);
	$effect(() => {
		void $hasAnySession;
		keystorePersisted = hasPersistedKeystore();
	});
	const hasAccount = $derived($hasAnySession || keystorePersisted);

	/** The chain's staking APR, as a display string ("1.70%"), or null. */
	let apr = $state<string | null>(null);
	let aprAsked = false;
	$effect(() => {
		if (aprAsked || !$instance.loaded) return;
		aprAsked = true;
		void fetchAccountBalance(resolveOrigin(MORPHIT_INDEXER_ORIGIN), $instance.relay_account)
			.then((r) => {
				if (r.kind !== 'ok') return;
				const value = computeBlurtVestingApr(r.data.dgp);
				// NaN for a rate no real chain state gives ($blurt/apr).
				if (Number.isFinite(value) && value > 0) apr = formatApr(value);
			})
			.catch(() => {});
	});

	type Tile = 'signin' | 'post' | 'chat' | 'welcome' | 'income' | 'loyalty';
	const tiles = $derived<readonly Tile[]>(
		paysRewards
			? ['signin', 'post', 'chat', 'welcome', 'income', 'loyalty']
			: ['signin', 'post', 'chat', 'income']
	);
	function tileBody(tile: Tile): string {
		if (tile === 'post' && !paysRewards) return $_('home.first_trades.tile_post_body_paid');
		if (tile === 'income')
			return apr !== null
				? $_('home.first_trades.tile_income_body', { values: { apr } })
				: $_('home.first_trades.tile_income_body_no_rate');
		return $_(`home.first_trades.tile_${tile}_body`);
	}
</script>

<section class="ftc mx-auto mb-24 mt-24 max-w-4xl" aria-labelledby="first-trades-heading">
	<div class="ftc-border" aria-hidden="true"></div>
	<div class="ftc-face">
		<div class="ftc-glow ftc-glow-a" aria-hidden="true"></div>
		<div class="ftc-glow ftc-glow-b" aria-hidden="true"></div>
		<div class="ftc-dots" aria-hidden="true"></div>

		<div class="relative px-6 py-10 text-center sm:px-10 md:py-12">
			<h2
				id="first-trades-heading"
				class="font-display text-3xl font-extrabold leading-tight tracking-tight md:text-4xl"
			>
				<span class="ftc-title">{$_('home.first_trades.heading')}</span>
			</h2>
			<p class="mx-auto mt-4 max-w-2xl text-lg text-ink-700 dark:text-ink-200">
				{$_('home.first_trades.body')}
			</p>

			<ol
				class="mx-auto mt-8 grid max-w-3xl gap-3 text-left sm:grid-cols-2 md:grid-cols-3"
				data-testid="first-trades-tiles"
			>
				{#each tiles as tile, i (tile)}
					<li class="ftc-tile" style="animation-delay: {(i % 3) * -2}s" data-tile={tile}>
						<span class="ftc-tile-num" aria-hidden="true">{i + 1}</span>
						<span>
							<strong class="ftc-tile-title">{$_(`home.first_trades.tile_${tile}_title`)}</strong>
							<span class="mt-1 block text-sm text-ink-700 dark:text-ink-300">{tileBody(tile)}</span
							>
						</span>
					</li>
				{/each}
			</ol>

			<div class="mt-8 flex flex-wrap items-center justify-center gap-3">
				{#if hasAccount}
					<a href={lp('/post')} class="btn-primary btn-shine" data-testid="first-trades-primary"
						>{$_('home.first_trades.cta_post')}</a
					>
					<a href={lp('/orderbook')} class="btn-secondary">{$_('home.first_trades.cta_browse')}</a>
				{:else}
					<a
						href={lp('/onboarding')}
						class="btn-primary btn-shine"
						data-testid="first-trades-primary"
						>{paysRewards
							? $_('home.first_trades.cta_signup_free')
							: $_('home.first_trades.cta_signup')}</a
					>
					<a href={lp('/login')} class="btn-secondary">{$_('home.first_trades.cta_login')}</a>
				{/if}
			</div>
		</div>
	</div>
</section>

<style>
	/* A rotating band of light along the border. The angle is a registered
	 * property so it can be animated; a browser without @property shows the
	 * same gradient, still. */
	@property --ftc-angle {
		syntax: '<angle>';
		inherits: false;
		initial-value: 0deg;
	}

	.ftc {
		position: relative;
		isolation: isolate;
		border-radius: 1.75rem;
		padding: 2px;
	}

	.ftc-border {
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: conic-gradient(
			from var(--ftc-angle),
			rgb(var(--brand-1-rgb) / 0.15),
			rgb(var(--brand-1-rgb)),
			rgb(var(--brand-2-rgb)),
			rgb(var(--brand-3-rgb)),
			rgb(var(--brand-3-rgb) / 0.15) 60%,
			rgb(var(--brand-1-rgb) / 0.15)
		);
		animation: ftc-spin 9s linear infinite;
		z-index: -1;
	}
	/* The same light, blurred, as a soft halo around the card. */
	.ftc-border::after {
		content: '';
		position: absolute;
		inset: -10px;
		border-radius: inherit;
		background: inherit;
		filter: blur(22px);
		opacity: 0.35;
	}

	.ftc-face {
		position: relative;
		overflow: hidden;
		border-radius: calc(1.75rem - 2px);
		background: rgb(var(--surface-950-rgb));
	}

	.ftc-glow {
		position: absolute;
		width: 26rem;
		height: 26rem;
		border-radius: 9999px;
		filter: blur(70px);
		opacity: 0.22;
		pointer-events: none;
	}
	.ftc-glow-a {
		top: -10rem;
		left: -8rem;
		background: rgb(var(--brand-1-rgb));
		animation: ftc-drift-a 18s ease-in-out infinite alternate;
	}
	.ftc-glow-b {
		bottom: -12rem;
		right: -8rem;
		background: rgb(var(--brand-3-rgb));
		animation: ftc-drift-b 22s ease-in-out infinite alternate;
	}

	/* A faint field of dots, fading toward the edges. */
	.ftc-dots {
		position: absolute;
		inset: 0;
		background-image: radial-gradient(rgb(var(--brand-2-rgb) / 0.18) 1px, transparent 1.5px);
		background-size: 22px 22px;
		mask-image: radial-gradient(ellipse at center, rgb(var(--surface-950-rgb)), transparent 70%);
		-webkit-mask-image: radial-gradient(
			ellipse at center,
			rgb(var(--surface-950-rgb)),
			transparent 70%
		);
		pointer-events: none;
	}

	/* The heading in the brand gradient, with a slow sweep of light across it. */
	.ftc-title {
		background: linear-gradient(
			100deg,
			rgb(var(--brand-1-rgb)) 0%,
			rgb(var(--brand-2-rgb)) 35%,
			rgb(var(--surface-50-rgb)) 50%,
			rgb(var(--brand-2-rgb)) 65%,
			rgb(var(--brand-3-rgb)) 100%
		);
		background-size: 250% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		animation: ftc-sheen 7s ease-in-out infinite;
	}

	/* Six numbered tiles in the brand tint, each floating gently (offset by
	 * column so neighbours never move in step). */
	.ftc-tile {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		border-radius: 1rem;
		border: 1px solid rgb(var(--brand-2-rgb) / 0.35);
		background: linear-gradient(
			160deg,
			rgb(var(--brand-1-rgb) / 0.1),
			rgb(var(--brand-3-rgb) / 0.08)
		);
		padding: 0.9rem 1rem;
		animation: ftc-float 6s ease-in-out infinite;
	}
	.ftc-tile-num {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 1.9rem;
		height: 1.9rem;
		border-radius: 9999px;
		background: var(--morphit-gradient);
		color: rgb(var(--surface-950-rgb));
		font-weight: 800;
	}
	.ftc-tile-title {
		display: block;
		font-family: var(--font-display, inherit);
		font-size: 1.05rem;
		font-weight: 800;
		color: rgb(var(--brand-primary-rgb));
	}

	@keyframes ftc-spin {
		to {
			--ftc-angle: 360deg;
		}
	}
	@keyframes ftc-drift-a {
		to {
			transform: translate(6rem, 4rem) scale(1.1);
		}
	}
	@keyframes ftc-drift-b {
		to {
			transform: translate(-5rem, -3rem) scale(1.15);
		}
	}
	@keyframes ftc-sheen {
		0%,
		100% {
			background-position: 100% 0;
		}
		50% {
			background-position: 0% 0;
		}
	}
	@keyframes ftc-float {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-4px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ftc-border,
		.ftc-glow,
		.ftc-title,
		.ftc-tile {
			animation: none;
		}
	}
</style>
